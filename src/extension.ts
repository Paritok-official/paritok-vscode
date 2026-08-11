import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ProxyManager } from "./proxyManager";
import {
  writeProxyConfig,
  CodexOptions,
  managedConfigPath,
  configFileSetting,
  scaffoldFullConfig,
} from "./paritokConfig";
import { offerInstall } from "./installer";
import {
  AGENTS,
  AgentId,
  EnableCtx,
  agentById,
  detectClaudeCode,
  healLegacyClaudeInjection,
} from "./agents";

const SECRET_KEY = "paritok.apiKey";
const STATE_ENABLED = "paritok.enabledAgents";

let proxy: ProxyManager;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let ctx: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {
  ctx = context;

  // EARLIEST possible line: if Claude Code was routed before this reload, set the
  // env var synchronously right now — before we create anything or await — so the
  // native Claude Code extension (re-activating in parallel) inherits it whenever
  // it spawns `claude`. This is what makes "Reload Window" reliably re-route.
  if (enabledIds().includes("claude-code")) {
    const cfg = vscode.workspace.getConfiguration("paritok");
    const host = cfg.get<string>("host", "127.0.0.1");
    const port = cfg.get<number>("port", 8080);
    process.env.ANTHROPIC_BASE_URL = `http://${host}:${port}`;
  }

  output = vscode.window.createOutputChannel("Paritok");
  proxy = new ProxyManager(output);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "paritok.showStats";
  context.subscriptions.push(output, status);

  // Self-heal: undo any leftover ~/.claude/settings.json injection from the old
  // (≤0.1.6) design so Claude Code is never left pointing at a dead local proxy.
  if (healLegacyClaudeInjection()) {
    output.appendLine(
      "[healed a leftover ANTHROPIC_BASE_URL in ~/.claude/settings.json from an older version]"
    );
  }
  // Reap any proxy this extension orphaned in a previous session (e.g. left
  // listening after an abrupt VS Code close). Only kills OUR config's process.
  proxy.reapOrphans();
  render();

  // Last-ditch cleanup: VS Code may cut off async deactivate() on shutdown, so
  // also kill the proxy synchronously when the extension-host process exits.
  const onHostExit = () => {
    try {
      clearClaudeEnv();
      proxy?.stop();
    } catch {
      /* best-effort */
    }
  };
  process.once("exit", onHostExit);
  context.subscriptions.push({ dispose: () => process.removeListener("exit", onHostExit) });

  context.subscriptions.push(
    vscode.commands.registerCommand("paritok.setApiKey", () => setApiKey()),
    vscode.commands.registerCommand("paritok.enable", () => enableMenu()),
    vscode.commands.registerCommand("paritok.enableClaudeCode", () => enableClaudeCode()),
    vscode.commands.registerCommand("paritok.enableCodex", () => enableCodex()),
    vscode.commands.registerCommand("paritok.enableContinue", () => enableContinue()),
    vscode.commands.registerCommand("paritok.disable", () => disable()),
    vscode.commands.registerCommand("paritok.restart", () => restart()),
    vscode.commands.registerCommand("paritok.showStats", () => showStats()),
    vscode.commands.registerCommand("paritok.installCli", () => installCli()),
    vscode.commands.registerCommand("paritok.openConfig", () => openConfig())
  );

  // Re-establish after a window reload/restart. Claude Code is re-established
  // regardless of autoStart (its routing is in-memory, lost on every reload, and
  // the user expects the native panel to keep working); Codex/Continue only when
  // autoStart is on. bringUp waits on /health, so if the proxy can't come up we
  // simply never set the env — the native panel just direct-connects, unbroken.
  const auto = vscode.workspace.getConfiguration("paritok").get<boolean>("autoStart", false);
  const key = await context.secrets.get(SECRET_KEY);
  const ids = enabledIds();
  if (key && ids.length && (auto || ids.includes("claude-code"))) {
    bringUp(key)
      .then(() => render())
      .catch((e) => output.appendLine(`auto-start failed: ${e.message}`));
  }
}

export async function deactivate() {
  // Kill the proxy FIRST (synchronous), before any awaited work — VS Code gives
  // shutdown a short budget, and an await here could get cut off before the kill
  // runs, orphaning the process. Restoring the config-wired agents is secondary.
  clearClaudeEnv();
  proxy?.stop();
  for (const id of enabledIds()) {
    try {
      await agentById(id)?.disable();
    } catch {
      /* ignore */
    }
  }
}

// ─────────────────────────────── state helpers ─────────────────────────────
function enabledIds(): AgentId[] {
  return (ctx.globalState.get<AgentId[]>(STATE_ENABLED) || []).filter(Boolean);
}
async function setEnabledIds(ids: AgentId[]) {
  await ctx.globalState.update(STATE_ENABLED, ids);
}
async function addEnabled(id: AgentId) {
  const s = new Set(enabledIds());
  s.add(id);
  await setEnabledIds([...s]);
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

async function ensureKey(): Promise<string | undefined> {
  const existing = await ctx.secrets.get(SECRET_KEY);
  if (existing) {
    return existing;
  }
  return setApiKey();
}

// ──────────────────────────────── proxy plumbing ───────────────────────────
/** Codex options from current state, or undefined when Codex isn't enabled. */
async function currentCodexOptions(): Promise<CodexOptions | undefined> {
  if (!enabledIds().includes("codex")) {
    return undefined;
  }
  const model =
    vscode.workspace.getConfiguration("paritok").get<string>("codexModel", "gpt-5") || "gpt-5";
  // Always requires_openai_auth: Codex carries its own login (subscription or
  // key) and paritok routes by token type — no key stored in the extension.
  return { model, subscription: true, apiKey: "" };
}

/**
 * The config `paritok up` will read. When the user set paritok.configFile we use
 * it AS-IS (seeding a full template once if missing) and never overwrite it;
 * otherwise we (re)generate the extension-managed minimal config.
 */
async function writeConfig(key: string): Promise<string> {
  const custom = configFileSetting();
  if (custom) {
    if (!fs.existsSync(custom)) {
      scaffoldFullConfig(custom, key, await currentCodexOptions());
    }
    return custom; // user-managed — never overwrite
  }
  return writeProxyConfig(ctx, key, { codex: await currentCodexOptions() });
}

/** Start the proxy (reusing a healthy one), offering a pip install if missing. */
async function startOrInstall(cfgPath: string, p?: vscode.Progress<{ message?: string }>) {
  try {
    await proxy.start(cfgPath);
  } catch (e: any) {
    if (/CLI was not found/.test(e.message || "")) {
      p?.report({ message: "installing CLI…" });
      const ok = await offerInstall(output);
      if (!ok) {
        throw e;
      }
      await proxy.start(cfgPath);
    } else {
      throw e;
    }
  }
}

/** Ensure some proxy is up (reuse if already healthy). Does not restart. */
async function ensureProxy(key: string, p?: vscode.Progress<{ message?: string }>) {
  p?.report({ message: "writing config…" });
  const cfgPath = await writeConfig(key);
  p?.report({ message: "starting proxy…" });
  await startOrInstall(cfgPath, p);
}

/** Restart the proxy so a fresh config (e.g. Codex's ~/.codex/config.toml) applies. */
async function restartProxy(key: string, p?: vscode.Progress<{ message?: string }>) {
  proxy.stop();
  p?.report({ message: "writing config…" });
  const cfgPath = await writeConfig(key);
  p?.report({ message: "starting proxy…" });
  await startOrInstall(cfgPath, p);
}

function enableCtx(): EnableCtx {
  return {
    baseAnthropic: `http://${proxy.host}:${proxy.port}`,
    baseOpenAIv1: `http://${proxy.host}:${proxy.port}/v1`,
  };
}

// Claude Code routing = an in-memory env var on the shared extension host. The
// native Claude Code extension spawns `claude` with {...process.env}, so a new
// session picks this up. Nothing on disk → nothing to break, nothing to restore.
function setClaudeEnv() {
  process.env.ANTHROPIC_BASE_URL = `http://${proxy.host}:${proxy.port}`;
}
function clearClaudeEnv() {
  delete process.env.ANTHROPIC_BASE_URL;
}

/** Re-apply wiring for the persisted agents (used by autoStart / restart). */
async function bringUp(key: string, p?: vscode.Progress<{ message?: string }>) {
  await restartProxy(key, p); // re-writes ~/.codex/config.toml if Codex is enabled
  if (enabledIds().includes("continue")) {
    const upstream = vscode.workspace
      .getConfiguration("paritok")
      .get<string>("upstream", "anthropic");
    await agentById("continue")!.enable(enableCtx(), { upstream });
  }
  if (enabledIds().includes("claude-code")) {
    setClaudeEnv();
  }
}

// ─────────────────────────────── enable: menu ──────────────────────────────
async function enableMenu() {
  const [ccDet, codexDet, contDet] = await Promise.all([
    detectClaudeCode(),
    agentById("codex")!.detect(),
    agentById("continue")!.detect(),
  ]);
  const items = [
    {
      label: "Claude Code",
      description: ccDet ? "$(check) detected" : "not detected",
      detail: "Subscription-friendly. Routes the native panel via an in-memory env var — no config files touched, nothing to undo.",
      id: "claude-code" as const,
    },
    {
      label: "Codex",
      description: codexDet ? "$(check) detected" : "not detected",
      detail: "Routes the `codex` CLI and the Codex VS Code panel — uses your own Codex login (subscription or key), no prompt.",
      id: "codex" as const,
    },
    {
      label: "Continue",
      description: contDet ? "$(check) detected" : "not detected",
      detail: "VS Code assistant (needs an API key). Edits ~/.continue/config.*",
      id: "continue" as const,
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Paritok — enable for which agent?",
    placeHolder: "Pick one (each agent has its own command too)",
  });
  if (!pick) {
    return;
  }
  if (pick.id === "claude-code") {
    return enableClaudeCode();
  }
  if (pick.id === "codex") {
    return enableCodex();
  }
  return enableContinue();
}

// ─────────────────────────── enable: Claude Code ───────────────────────────
async function enableClaudeCode() {
  try {
    const key = await ensureKey();
    if (!key) {
      return;
    }
    await addEnabled("claude-code");
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Paritok: starting proxy for Claude Code" },
      async (p) => ensureProxy(key, p)
    );
    setClaudeEnv(); // only after the proxy is confirmed healthy (ensureProxy waits on /health)
    render();
    // Reload picks it up cleanly (we re-set the env synchronously at the very
    // start of activation, so the native extension inherits it on restart).
    // Starting a new session works too — an already-running one keeps its old
    // endpoint until then. Reload is the one-click path.
    const r = await vscode.window.showInformationMessage(
      `Paritok: Claude Code routed (proxy on ${proxy.host}:${proxy.port}). ` +
        `Reload the window (or start a new Claude Code session) to pick it up. ` +
        `Nothing is written to ~/.claude; it clears when VS Code closes.`,
      "Reload Window"
    );
    if (r === "Reload Window") {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (e: any) {
    render();
    vscode.window.showErrorMessage(`Paritok: ${e.message}`);
    output.appendLine(`enableClaudeCode failed: ${e.stack || e.message}`);
  }
}

// ─────────────────────────────── enable: Codex ─────────────────────────────
async function enableCodex() {
  try {
    const key = await ensureKey();
    if (!key) {
      return;
    }
    // With a self-managed config the codex: block lives in the user's file, so
    // don't prompt — just (re)start so their edits apply, and point them to it.
    if (configFileSetting()) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Paritok: restarting for Codex" },
        async (p) => restartProxy(key, p)
      );
      render();
      const open = await vscode.window.showInformationMessage(
        "Paritok: Codex is driven by your self-managed config — edit its `codex:` block (enabled/subscription/api_key). Proxy restarted.",
        "Open Config"
      );
      if (open === "Open Config") {
        openConfig();
      }
      return;
    }
    const codex = agentById("codex")!;
    if (!(await codex.detect())) {
      const go = await vscode.window.showWarningMessage(
        "Paritok: Codex (CLI or the Codex VS Code extension) wasn't detected. Enable anyway?",
        "Enable",
        "Cancel"
      );
      if (go !== "Enable") {
        return;
      }
    }
    // No auth prompt — like Claude Code, Codex uses its own login and paritok
    // routes by token type (see currentCodexOptions).
    await addEnabled("codex");
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Paritok: enabling Codex" },
      async (p) => restartProxy(key, p)
    );
    render();
    const r = await vscode.window.showInformationMessage(
      `Paritok: Codex routed (proxy on ${proxy.host}:${proxy.port}). ` +
        `Sign into Codex (ChatGPT subscription or API key) if you haven't. ` +
        `Reload the window or start a new Codex session to apply.`,
      "Reload Window"
    );
    if (r === "Reload Window") {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (e: any) {
    render();
    vscode.window.showErrorMessage(`Paritok: ${e.message}`);
    output.appendLine(`enableCodex failed: ${e.stack || e.message}`);
  }
}

// ────────────────────────────── enable: Continue ───────────────────────────
async function enableContinue() {
  try {
    const key = await ensureKey();
    if (!key) {
      return;
    }
    const cont = agentById("continue")!;
    const data = await cont.collect!(ctx);
    if (data === undefined) {
      return;
    }
    await addEnabled("continue");
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Paritok: enabling Continue" },
      async (p) => {
        await ensureProxy(key, p);
        p.report({ message: "wiring Continue…" });
        await cont.enable(enableCtx(), data);
      }
    );
    render();
    const r = await vscode.window.showInformationMessage(
      `Paritok: Continue routed (proxy on ${proxy.host}:${proxy.port}). Reload the window so Continue picks up the endpoint.`,
      "Reload Window"
    );
    if (r === "Reload Window") {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (e: any) {
    render();
    vscode.window.showErrorMessage(`Paritok: ${e.message}`);
    output.appendLine(`enableContinue failed: ${e.stack || e.message}`);
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
  clearClaudeEnv(); // Claude Code isn't in AGENTS — undo its in-memory routing here
  proxy.stop();
  await setEnabledIds([]);
  render();
  vscode.window.showInformationMessage(
    ids.length
      ? `Paritok stopped; restored ${ids.length} agent config(s).`
      : "Paritok proxy stopped."
  );
}

// ───────────────────────────────── restart ─────────────────────────────────
async function restart() {
  const key = await ctx.secrets.get(SECRET_KEY);
  if (!key) {
    vscode.window.showInformationMessage("Paritok: set an API key first ('Paritok: Set API Key').");
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Paritok: restarting proxy" },
      async (p) => bringUp(key, p)
    );
    render();
    vscode.window.showInformationMessage("Paritok proxy restarted.");
  } catch (e: any) {
    render();
    vscode.window.showErrorMessage(`Paritok: ${e.message}`);
  }
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

// ──────────────────────────────── open config ──────────────────────────────
async function openConfig() {
  const custom = configFileSetting();
  const p = custom || managedConfigPath(ctx);
  const key = (await ctx.secrets.get(SECRET_KEY)) || "";

  if (!fs.existsSync(p)) {
    if (custom) {
      scaffoldFullConfig(p, key, await currentCodexOptions());
    } else if (key) {
      await writeConfig(key); // materialize the managed config as it is today
    } else {
      scaffoldFullConfig(p, "", await currentCodexOptions()); // no key yet → a full starting template
    }
  }

  const doc = await vscode.workspace.openTextDocument(p);
  await vscode.window.showTextDocument(doc);

  if (!custom) {
    const pick = await vscode.window.showWarningMessage(
      "This is the extension-managed config — it is rewritten every time you Enable, so edits here are lost. " +
        "To change advanced settings (backend, timeouts, history, tool_discovery, trace…) permanently, use a self-managed config file.",
      "Create editable config",
      "Dismiss"
    );
    if (pick === "Create editable config") {
      const target = path.join(ctx.globalStorageUri.fsPath, "paritok.user.yaml");
      if (!fs.existsSync(target)) {
        scaffoldFullConfig(target, key, await currentCodexOptions());
      }
      await vscode.workspace
        .getConfiguration("paritok")
        .update("configFile", target, vscode.ConfigurationTarget.Global);
      const d = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(d);
      vscode.window.showInformationMessage(
        "Paritok: now using your self-managed config (paritok.configFile). Edit it, then run Enable/Restart. It won't be overwritten."
      );
    }
  }
}

// ─────────────────────────────────── stats ─────────────────────────────────
async function showStats() {
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
    vscode.window.showInformationMessage(
      "Paritok: no proxy answered /stats. Enable an agent first (the proxy starts with it)."
    );
  }
}

// ─────────────────────────────────── ui ────────────────────────────────────
function render() {
  const n = enabledIds().length;
  if (proxy?.running) {
    status.text = `$(plug) paritok :${proxy.port}${n ? ` (${n})` : ""}`;
    status.tooltip = `Paritok proxy on :${proxy.port}${n ? ` — ${n} wired agent(s)` : ""} — click for /stats`;
  } else {
    status.text = "$(circle-slash) paritok off";
    status.tooltip = "Paritok proxy stopped — run 'Paritok: Enable'";
  }
  status.show();
}
