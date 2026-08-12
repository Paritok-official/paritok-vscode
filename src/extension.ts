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
import { OLLAMA_DOWNLOAD, ollamaModels, modelPresent, gpuKeyState } from "./backend";
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

  // Re-establish (or heal) enabled agents after a reload/restart/crash. Codex and
  // Continue write PERSISTENT configs pointing at the proxy, so if they're enabled
  // the proxy MUST be running — otherwise their config is left pointing at a dead
  // port (e.g. after a crash where deactivate never ran). So: if anything is
  // enabled, bring the proxy up and re-wire; if that fails, RESTORE the configs so
  // nothing dangles. (Claude Code is in-memory and always safe either way.)
  const key = (await context.secrets.get(SECRET_KEY)) ?? "";
  if (enabledIds().length) {
    if (key || proxyKeyOptional()) {
      bringUp(key)
        .then(() => render())
        .catch(async (e) => {
          output.appendLine(
            `Paritok: proxy did not start (${e.message}); restoring agent configs so nothing points at a dead proxy.`
          );
          await healEnabledConfigs();
          render();
        });
    } else {
      // Enabled but no API key → the proxy can't run → restore persistent redirects.
      await healEnabledConfigs();
      render();
    }
  }
}

/**
 * Restore the config-wired agents (Codex's ~/.codex/config.toml, Continue's
 * config) to their pre-Paritok state so a session that couldn't bring the proxy
 * up never leaves them pointing at a dead port. Keeps the enabled selection, so
 * the next launch that CAN start the proxy re-establishes them.
 */
async function healEnabledConfigs() {
  for (const id of enabledIds()) {
    try {
      await agentById(id)?.disable();
    } catch {
      /* best-effort */
    }
  }
  clearClaudeEnv();
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
  // Empty by default → Codex picks the model (its picker / -m flag / default).
  // No auth here: Codex uses its own login and paritok routes by token type.
  const model = vscode.workspace.getConfiguration("paritok").get<string>("codexModel", "");
  return { model };
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

// ───────────────────────────── backend preflight ───────────────────────────
/** True when the proxy can start with no Paritok key — self-hosted Ollama backend. */
function proxyKeyOptional(): boolean {
  if (configFileSetting()) {
    return false; // user-owned config is opaque; keep requiring a key to be safe
  }
  return vscode.workspace.getConfiguration("paritok").get<boolean>("useGpuServer", true) === false;
}

/** The key to start the proxy with: prompt for GPU mode, optional (empty) for local Ollama.
 *  Returns undefined only when the user cancelled the key prompt (caller aborts). */
async function keyForBackend(): Promise<string | undefined> {
  if (proxyKeyOptional()) {
    return (await ctx.secrets.get(SECRET_KEY)) ?? ""; // local Ollama needs no Paritok key
  }
  return ensureKey();
}

/**
 * Warn before enabling when the chosen backend isn't ready. Returns true to
 * proceed, false to abort. A self-managed configFile is opaque (we don't parse
 * it) so the check is skipped there.
 *   - GPU server (use_gpu_server: true, the default): no key or a rejected key → warn.
 *   - Local Ollama (use_gpu_server: false): Ollama unreachable → offer the download
 *     page; the model not pulled → offer to pull it right away.
 */
async function preflightBackend(): Promise<boolean> {
  if (configFileSetting()) {
    return true;
  }
  const c = vscode.workspace.getConfiguration("paritok");

  if (c.get<boolean>("useGpuServer", true)) {
    const key = await ctx.secrets.get(SECRET_KEY);
    if (!key) {
      const pick = await vscode.window.showWarningMessage(
        "Paritok: the GPU server backend (use_gpu_server: true) needs a Paritok API key. " +
          "Set one, or switch to local Ollama (use_gpu_server: false).",
        "Set API Key",
        "Cancel"
      );
      return pick === "Set API Key" ? (await setApiKey()) !== undefined : false;
    }
    const base = c.get<string>("gpuServerBaseUrl", "https://www.paritok.com/api");
    if ((await gpuKeyState(base, key)) === false) {
      const pick = await vscode.window.showWarningMessage(
        "Paritok: the GPU server rejected your API key (invalid or expired). " +
          "Update it, or switch to local Ollama.",
        "Set API Key",
        "Enable Anyway",
        "Cancel"
      );
      if (pick === "Set API Key") {
        return (await setApiKey()) !== undefined;
      }
      return pick === "Enable Anyway";
    }
    return true; // valid, or couldn't determine (don't block on a network hiccup)
  }

  // Local Ollama backend.
  const base = c.get<string>("localModelBaseUrl", "http://localhost:11434/v1");
  const model = c.get<string>("localModelModel", "paritok-4b-v1");
  const models = await ollamaModels(base);
  if (models === null) {
    const pick = await vscode.window.showWarningMessage(
      `Paritok: local backend is on (use_gpu_server: false) but Ollama isn't reachable at ${base}. ` +
        "Install Ollama and start it (`ollama serve`).",
      "Install Ollama",
      "Enable Anyway",
      "Cancel"
    );
    if (pick === "Install Ollama") {
      vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD));
    }
    return pick === "Enable Anyway";
  }
  if (!modelPresent(models, model)) {
    const pick = await vscode.window.showWarningMessage(
      `Paritok: Ollama is running but the model "${model}" isn't pulled yet.`,
      "Pull Model",
      "Enable Anyway",
      "Cancel"
    );
    if (pick === "Pull Model") {
      const term = vscode.window.createTerminal("Paritok: ollama pull");
      term.show();
      term.sendText(`ollama pull ${model}`);
      vscode.window.showInformationMessage(
        `Paritok: pulling "${model}" in a terminal — re-run Enable once it finishes.`
      );
      return false; // let the pull run; the user re-enables when it's done
    }
    return pick === "Enable Anyway";
  }
  return true;
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
    if (!(await preflightBackend())) {
      return;
    }
    const key = await keyForBackend();
    if (key === undefined) {
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
    if (!(await preflightBackend())) {
      return;
    }
    const key = await keyForBackend();
    if (key === undefined) {
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
    if (!(await preflightBackend())) {
      return;
    }
    const key = await keyForBackend();
    if (key === undefined) {
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
