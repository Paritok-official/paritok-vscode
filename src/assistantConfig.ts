import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Wires the AI assistant (Continue's classic config.json) to route through the
 * local proxy by rewriting each OpenAI/Anthropic model's `apiBase`, preserving
 * everything else (including the user's upstream API keys — paritok forwards the
 * Authorization header unchanged to the real provider).
 *
 * The ENTIRE original file is backed up next to it, so Disable Proxy Mode is a
 * byte-for-byte restore. We never touch the file if we can't parse it.
 *
 * Scope note: this handles Continue's legacy JSON config. Newer Continue uses a
 * YAML config (config.yaml) and Cline stores models in its own settings; those
 * are detected and reported, not silently edited. See README "Known limits".
 */
const BACKUP_SUFFIX = ".paritok-bak";

export interface WireResult {
  configPath: string;
  changed: number;
  baseUrl: string;
}

function defaultContinuePath(): string {
  return path.join(os.homedir(), ".continue", "config.json");
}

function resolveConfigPath(): string {
  const override = vscode.workspace
    .getConfiguration("paritok")
    .get<string>("assistantConfigPath", "");
  return override && override.trim() ? override.trim() : defaultContinuePath();
}

/** True when a Continue install is present in some form (json or yaml). */
export function detectAssistant(): { jsonExists: boolean; yamlExists: boolean; jsonPath: string } {
  const jsonPath = resolveConfigPath();
  const yamlPath = path.join(os.homedir(), ".continue", "config.yaml");
  return {
    jsonExists: fs.existsSync(jsonPath),
    yamlExists: fs.existsSync(yamlPath),
    jsonPath,
  };
}

/**
 * Redirect matching models to `baseUrl`. Returns how many entries changed.
 * Throws with an actionable message when the config is missing or unparseable.
 */
export function wire(baseUrl: string, upstream: string): WireResult {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Continue config not found at ${configPath}. Install the Continue ` +
        `extension and add at least one model, or set paritok.assistantConfigPath.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error(
      `Could not parse ${configPath} as JSON. If this is a newer Continue ` +
        `config.yaml, wire it manually (see the README) — the extension will ` +
        `not edit YAML to avoid corrupting it.`
    );
  }

  // Back up the untouched original once per enable.
  fs.writeFileSync(configPath + BACKUP_SUFFIX, raw, "utf8");

  const wanted = upstream === "openai" ? "openai" : "anthropic";
  const models: any[] = Array.isArray(cfg.models) ? cfg.models : [];
  let changed = 0;
  for (const m of models) {
    if (m && typeof m === "object" && m.provider === wanted) {
      if (m.apiBase !== baseUrl) {
        m.apiBase = baseUrl;
        changed++;
      }
    }
  }

  if (changed === 0) {
    // Nothing matched — remove the just-written backup so Disable doesn't
    // "restore" a no-op, and tell the caller so it can warn the user.
    fs.rmSync(configPath + BACKUP_SUFFIX, { force: true });
    throw new Error(
      `No '${wanted}' models found in ${configPath} to redirect. Add a ` +
        `${wanted} model in Continue first, or switch paritok.upstream.`
    );
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
  return { configPath, changed, baseUrl };
}

/** Restore the byte-for-byte backup if present. Returns true if restored. */
export function unwire(): boolean {
  const configPath = resolveConfigPath();
  const backup = configPath + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    return false;
  }
  const original = fs.readFileSync(backup, "utf8");
  fs.writeFileSync(configPath, original, "utf8");
  fs.rmSync(backup, { force: true });
  return true;
}
