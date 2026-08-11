import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** The extension-managed config (regenerated on each Enable). */
export function managedConfigPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "paritok.yaml");
}

/** A user-managed config path from settings (expanded), or "" when unset. */
export function configFileSetting(): string {
  const raw = vscode.workspace.getConfiguration("paritok").get<string>("configFile", "").trim();
  if (!raw) {
    return "";
  }
  return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
}

/** The config `paritok up` should read: the user's file if set, else the managed one. */
export function activeConfigPath(context: vscode.ExtensionContext): string {
  return configFileSetting() || managedConfigPath(context);
}

/**
 * Write a FULL, commented paritok.yaml (every common setting) so the user can
 * edit advanced options — backend, timeouts, history, tool_discovery, trace, …
 * Only used to seed a self-managed config; never overwrites an existing file.
 */
export function scaffoldFullConfig(filePath: string, apiKey: string, codex?: CodexOptions): void {
  const q = (s: string) => s.replace(/"/g, '\\"');
  const codexBlock = codex
    ? [
        "codex:",
        "  enabled: true",
        `  model: "${q(codex.model)}"`,
        `  subscription: ${codex.subscription ? "true" : "false"}`,
        `  api_key: "${q(codex.apiKey)}"`,
      ]
    : [
        "codex:",
        "  enabled: false          # true → paritok writes ~/.codex/config.toml so Codex routes here",
        "  model: gpt-5",
        "  subscription: true      # default: ChatGPT login (run `codex login`). false → use api_key",
        '  api_key: ""             # only used when subscription: false (empty → env OPENAI_API_KEY)',
      ];
  const lines = [
    "# Paritok config — edit freely. Because paritok.configFile points here, the",
    "# extension uses this file AS-IS and never overwrites it.",
    "",
    "# Backend switch:",
    "#   true  → Paritok GPU server (needs an API key from https://paritok.com)",
    "#   false → self-host the open model locally via Ollama",
    "use_gpu_server: true",
    "",
    "gpu_server:                # used when use_gpu_server: true",
    "  base_url: https://www.paritok.com/api",
    "  model: paritok-4b-v1",
    `  api_key: "${q(apiKey)}"    # or set env PARITOK_API_KEY`,
    "  timeout: 90.0",
    "",
    "local_model:               # used when use_gpu_server: false",
    "  base_url: http://localhost:11434/v1",
    "  model: paritok-4b-v1",
    "  temperature: 0",
    "  timeout: 300.0",
    "",
    "compression:",
    "  min_tokens: 512          # skip compression below this",
    "  max_tokens: 50000        # skip compression above this",
    "  refusal_threshold: 0.05  # must save at least 5% or keep the original",
    "",
    "history:",
    "  enabled: true",
    "  keep_recent_turns: 4     # keep last N turns intact",
    "  context_threshold: 0.8   # compress old turns when >80% of the window is used",
    "  context_window: 200000",
    "",
    "tool_discovery:",
    "  strategy: embedding      # \"embedding\" | \"relevance\" | \"passthrough\"",
    "  top_k: 5",
    "  k_max: 8",
    "  adaptive: true",
    "  mcp_signal_threshold: 1.0",
    "",
    "# Per-compression debug trace — logs every original→compressed pair.",
    "trace:",
    "  enabled: false",
    "  path: compress_trace.jsonl",
    "",
    ...codexBlock,
    "",
    'shadow_storage: memory     # "memory" | "redis" (redis needs paritok[redis])',
    "",
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

export interface CodexOptions {
  model: string;
  /** true → ChatGPT subscription (requires_openai_auth, no key). false → use apiKey. */
  subscription: boolean;
  /** OpenAI key (only when subscription is false); "" → env OPENAI_API_KEY. */
  apiKey: string;
}

export interface ProxyConfigOptions {
  /** When set, paritok.yaml enables the codex block so `paritok up` writes ~/.codex/config.toml. */
  codex?: CodexOptions;
}

/** A setting's value only if the user explicitly set it (else undefined). */
function explicitSetting<T>(c: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const ins = c.inspect<T>(key);
  return ins?.workspaceFolderValue ?? ins?.workspaceValue ?? ins?.globalValue;
}

/** Render a YAML scalar (numbers/bools verbatim; strings quoted). */
function yval(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

/** A YAML section that emits only the fields the user explicitly set (or none). */
function optionalSection(
  c: vscode.WorkspaceConfiguration,
  header: string,
  fields: Array<[settingKey: string, yamlKey: string]>
): string[] {
  const body: string[] = [];
  for (const [settingKey, yamlKey] of fields) {
    const v = explicitSetting(c, settingKey);
    if (v !== undefined) {
      body.push(`  ${yamlKey}: ${yval(v)}`);
    }
  }
  return body.length ? [`${header}:`, ...body] : [];
}

/**
 * Writes paritok.yaml into the extension's global storage and returns its path.
 * This is the config the spawned `paritok up` process reads.
 *
 * Design: we always write the backend (gpu_server needs the api_key) and the
 * `codex:` block, then emit engine sections (compression, history,
 * tool_discovery, trace, …) ONLY for the paritok.* settings the user actually
 * changed — untouched fields are omitted so paritok's own defaults still apply.
 * (When paritok.configFile is set the extension uses that file instead and never
 * calls this — see extension.ts.)
 */
export async function writeProxyConfig(
  context: vscode.ExtensionContext,
  apiKey: string,
  opts: ProxyConfigOptions = {}
): Promise<string> {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, "paritok.yaml");

  const c = vscode.workspace.getConfiguration("paritok");
  const q = (s: string) => s.replace(/"/g, '\\"');
  const useGpu = explicitSetting<boolean>(c, "useGpuServer") ?? true;

  const lines: string[] = [
    "# Generated by the Paritok VS Code extension from your paritok.* settings +",
    "# stored keys. Do not edit by hand — it is rewritten on each Enable. To own",
    "# this file yourself, run 'Paritok: Open Config' → Create editable config.",
    `use_gpu_server: ${useGpu}`,
    // gpu_server always present (it carries the api_key); fields honor settings.
    "gpu_server:",
    `  base_url: ${yval(explicitSetting<string>(c, "gpuServerBaseUrl") ?? "https://www.paritok.com/api")}`,
    `  model: ${yval(explicitSetting<string>(c, "gpuServerModel") ?? "paritok-4b-v1")}`,
    `  api_key: "${q(apiKey)}"`,
    `  timeout: ${explicitSetting<number>(c, "gpuServerTimeout") ?? 90}`,
    ...optionalSection(c, "local_model", [
      ["localModelBaseUrl", "base_url"],
      ["localModelModel", "model"],
      ["localModelTimeout", "timeout"],
    ]),
    ...optionalSection(c, "compression", [
      ["compressionMinTokens", "min_tokens"],
      ["compressionMaxTokens", "max_tokens"],
      ["compressionRefusalThreshold", "refusal_threshold"],
    ]),
    ...optionalSection(c, "history", [
      ["historyEnabled", "enabled"],
      ["historyKeepRecentTurns", "keep_recent_turns"],
      ["historyContextThreshold", "context_threshold"],
      ["historyContextWindow", "context_window"],
    ]),
    ...optionalSection(c, "tool_discovery", [
      ["toolDiscoveryStrategy", "strategy"],
      ["toolDiscoveryTopK", "top_k"],
      ["toolDiscoveryKMax", "k_max"],
      ["toolDiscoveryAdaptive", "adaptive"],
      ["toolDiscoveryMcpSignalThreshold", "mcp_signal_threshold"],
    ]),
    ...optionalSection(c, "trace", [
      ["traceEnabled", "enabled"],
      ["tracePath", "path"],
    ]),
  ];

  // Codex routing: paritok writes ~/.codex/config.toml when codex.enabled is true.
  if (opts.codex) {
    lines.push(
      "codex:",
      "  enabled: true",
      `  model: "${q(opts.codex.model)}"`,
      `  subscription: ${opts.codex.subscription ? "true" : "false"}`,
      `  api_key: "${q(opts.codex.apiKey)}"`
    );
  } else {
    lines.push("codex:", "  enabled: false");
  }

  const shadow = explicitSetting<string>(c, "shadowStorage");
  if (shadow !== undefined) {
    lines.push(`shadow_storage: ${yval(shadow)}`);
  }
  lines.push("");

  fs.writeFileSync(cfgPath, lines.join("\n"), "utf8");
  return cfgPath;
}
