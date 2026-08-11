import * as vscode from "vscode";
import { ProxyManager } from "./proxyManager";
import { writeProxyConfig, CodexOptions } from "./paritokConfig";
import { offerInstall } from "./installer";
import { AGENTS, Agent, AgentId, EnableCtx, agentById } from "./agents";

const SECRET_KEY = "paritok.apiKey";
const STATE_ENABLED = "paritok.enabledAgents";

let proxy: ProxyManager;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let ctx: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {
  ctx = context;
  output = vscode.window.createOutputChannel("Paritok");
  proxy = new ProxyManager(output);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "paritok.showStats";
  context.subscriptions.push(output, status);
  render();

  context.subscriptions.push(
    vscode.commands.registerCommand("paritok.setApiKey", () => setApiKey()),
    vscode.commands.registerCommand("paritok.enable", () => enable()),
    vscode.commands.registerCommand("paritok.disable", () => disable()),
    vscode.commands.registerCommand("paritok.restart", async () => {
      await disable();
      await enable();
    }),
    vscode.commands.registerCommand("paritok.showStats", () => showStats()),
    vscode.commands.registerCommand("paritok.installCli", () => installCli())
  );

  const auto = vscode.workspace.getConfiguration("paritok").get<boolean>("autoStart", false);
  if (auto && (await context.secrets.get(SECRET_KEY)) && enabledIds().length) {
    enable().catch((e) => output.appendLine(`auto-start failed: ${e.message}`));
  }
}

export async function deactivate() {
  // Best-effort: restore every wired agent and kill the proxy.
  for (const id of enabledIds()) {
    try {
      await agentById(id)?.disable();
    } catch {
      /* ignore */
    }
  }
  proxy?.stop();
}

// ─────────────────────────────── state helpers ─────────────────────────────
function enabledIds(): AgentId[] {
  return (ctx.globalState.get<AgentId[]>(STATE_ENABLED) || []).filter(Boolean);
}
async function setEnabledIds(ids: AgentId[]) {
  await ctx.globalState.update(STATE_ENABLED, ids);
}

// ─────────────────────────────────── key ───────────────────────────────────
async function setApiKey(): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: "Paritok API key (create one at paritok.com → dashboard → API keys)",
    placeHolder: "pk_live_...",
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return undefined;
  }
  if (!value.trim()) {
    await ctx.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage("Paritok API key cleared.");
    return undefined;
  }
  await ctx.secrets.store(SECRET_KEY, value.trim());
  vscode.window.showInformationMessage("Paritok API key saved.");
  return value.trim();
}

// ────────────────────────────────── enable ─────────────────────────────────
async function enable() {
  try {
    let key = await ctx.secrets.get(SECRET_KEY);
    if (!key) {
      key = await setApiKey();
      if (!key) {
        return;
      }
    }

    // 1) Which agents to route? Detected ones are pre-checked.
    const detected = await Promise.all(AGENTS.map((a) => a.detect()));
    const items = AGENTS.map((a, i) => ({
      label: a.label,
      description: detected[i] ? "$(check) detected" : "not detected",
      detail: a.detail,
      picked: detected[i],
      id: a.id as AgentId,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Paritok — route which agents through the proxy?",
      placeHolder: "Space to toggle, Enter to confirm",
    });
    if (!chosen || chosen.length === 0) {
      return;
    }
    const selected: Agent[] = chosen.map((c) => agentById(c.id)!).filter(Boolean);

    // 2) Gather inputs (keys/models), reusing stored secrets. Cancelling ONE
    //    agent skips only that agent — the others still get enabled.
    const collected = new Map<AgentId, any>();
    const active: Agent[] = [];
    for (const a of selected) {
      const data = a.collect ? await a.collect(ctx) : {};
      if (data === undefined) {
        vscode.window.showWarningMessage(`Paritok: skipped ${a.label} (setup cancelled).`);
        continue;
      }
      collected.set(a.id, data);
      active.push(a);
    }
    if (active.length === 0) {
      vscode.window.showInformationMessage("Paritok: nothing enabled.");
      return;
    }

    // 3) Codex is wired by paritok itself → fold its options into paritok.yaml.
    let codexOpts: CodexOptions | undefined;
    if (active.some((a) => a.id === "codex")) {
      const d = collected.get("codex");
      codexOpts = { model: d.model, apiKey: d.apiKey };
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Paritok: enabling" },
      async (p) => {
        // 4) Ensure the CLI, then (re)start the proxy with the fresh config.
        if (!(await proxy.checkInstalled())) {
          p.report({ message: "installing CLI…" });
          const ok = await offerInstall(output);
          if (!ok || !(await proxy.checkInstalled())) {
            throw new Error(
              'paritok CLI unavailable. Install it:  pip install "paritok[proxy]"  ' +
                "or set paritok.paritokCommand."
            );
          }
        }
        p.report({ message: "writing config…" });
        const cfgPath = await writeProxyConfig(ctx, key!, { codex: codexOpts });

        p.report({ message: "starting proxy…" });
        proxy.stop(); // apply the fresh yaml (also (re)writes ~/.codex/config.toml)
        await proxy.start(cfgPath);

        // 5) Wire the file-config agents (Codex already wired by paritok at start).
        const ectx: EnableCtx = {
          baseAnthropic: `http://${proxy.host}:${proxy.port}`,
          baseOpenAIv1: `http://${proxy.host}:${proxy.port}/v1`,
        };
        p.report({ message: "wiring agents…" });
        for (const a of active) {
          if (!a.viaProxy) {
            await a.enable(ectx, collected.get(a.id));
          }
        }
      }
    );

    await setEnabledIds(active.map((a) => a.id));
    render();

    // 6) Summary + per-agent next steps.
    const hints = active.map((a) => a.postEnableHint).filter(Boolean) as string[];
    const names = active.map((a) => a.label).join(", ");
    const needReload = active.some((a) => a.id === "continue");
    const msg = `Paritok routing: ${names} (proxy on ${proxy.host}:${proxy.port}).` +
      (hints.length ? "\n• " + hints.join("\n• ") : "");
    if (needReload) {
      const r = await vscode.window.showInformationMessage(msg, "Reload Window");
      if (r === "Reload Window") {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } else {
      vscode.window.showInformationMessage(msg);
    }
  } catch (e: any) {
    render();
    vscode.window.showErrorMessage(`Paritok: ${e.message}`);
    output.appendLine(`enable failed: ${e.stack || e.message}`);
  }
}

// ───────────────────────────────── disable ─────────────────────────────────
async function disable() {
  const ids = enabledIds();
  for (const id of ids) {
    try {
      await agentById(id)?.disable();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Paritok: could not restore ${id} — ${e.message}`);
    }
  }
  proxy.stop();
  await setEnabledIds([]);
  render();
  vscode.window.showInformationMessage(
    ids.length
      ? `Paritok stopped; restored ${ids.length} agent config(s).`
      : "Paritok proxy stopped."
  );
}

// ──────────────────────────────── CLI install ──────────────────────────────
async function installCli() {
  if (await proxy.checkInstalled()) {
    vscode.window.showInformationMessage("Paritok CLI is already installed.");
    return;
  }
  try {
    const ok = await offerInstall(output);
    if (ok && (await proxy.checkInstalled())) {
      vscode.window.showInformationMessage("Paritok CLI installed. Run 'Paritok: Enable'.");
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Paritok: install failed — ${e.message}`);
  }
}

// ─────────────────────────────────── stats ─────────────────────────────────
async function showStats() {
  if (!proxy.running) {
    vscode.window.showInformationMessage("Paritok proxy is not running. Run 'Paritok: Enable'.");
    return;
  }
  try {
    const stats = await proxy.fetchStats();
    let pretty = stats;
    try {
      pretty = JSON.stringify(JSON.parse(stats), null, 2);
    } catch {
      /* leave as-is */
    }
    const doc = await vscode.workspace.openTextDocument({ content: pretty, language: "json" });
    vscode.window.showTextDocument(doc, { preview: true });
  } catch (e: any) {
    vscode.window.showErrorMessage(`Paritok: could not fetch /stats — ${e.message}`);
  }
}

// ─────────────────────────────────── ui ────────────────────────────────────
function render() {
  const n = enabledIds().length;
  if (proxy?.running) {
    status.text = `$(plug) paritok :${proxy.port}${n ? ` (${n})` : ""}`;
    status.tooltip = `Paritok routing ${n} agent(s) on :${proxy.port} — click for /stats`;
  } else {
    status.text = "$(circle-slash) paritok off";
    status.tooltip = "Paritok proxy stopped — run 'Paritok: Enable'";
  }
  status.show();
}
