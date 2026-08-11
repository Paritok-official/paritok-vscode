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

/**
 * Writes a minimal paritok.yaml into the extension's global storage and returns
 * its path. This is the config the spawned `paritok up` process reads.
 *
 * We set only what the hosted (GPU-server) backend needs plus, optionally, the
 * `codex:` block — because paritok itself writes ~/.codex/config.toml from that
 * block on startup. Everything else falls back to paritok's own defaults, so we
 * never fossilize the engine's tuning (min_tokens, history, tool_discovery, ...)
 * into the extension — the Python side owns all of that.
 */
export async function writeProxyConfig(
  context: vscode.ExtensionContext,
  apiKey: string,
  opts: ProxyConfigOptions = {}
): Promise<string> {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, "paritok.yaml");

  const q = (s: string) => s.replace(/"/g, '\\"');
  const lines = [
    "# Generated by the Paritok VS Code extension. Do not edit by hand —",
    "# it is rewritten from the extension's settings + stored keys.",
    "use_gpu_server: true",
    "gpu_server:",
    "  base_url: https://www.paritok.com/api",
    "  model: paritok-4b-v1",
    `  api_key: "${q(apiKey)}"`,
    "  timeout: 60.0",
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
  lines.push("");

  fs.writeFileSync(cfgPath, lines.join("\n"), "utf8");
  return cfgPath;
}
