import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

/**
 * Wires the AI assistant to route through the local proxy by rewriting each
 * OpenAI/Anthropic model's `apiBase`, preserving everything else (including the
 * user's upstream API keys — paritok forwards the Authorization header unchanged
 * to the real provider).
 *
 * Supports BOTH Continue config formats:
 *   - config.json  (classic)
 *   - config.yaml  (newer Continue default)
 *
 * The ENTIRE original file is backed up byte-for-byte next to it, so Disable
 * Proxy Mode restores the exact original — comments and formatting included.
 * (While proxy mode is ON, a rewritten config.yaml is re-serialized and loses
 * comments; they come back verbatim on restore. This is called out in the README.)
 */
const BACKUP_SUFFIX = ".paritok-bak";

export interface WireResult {
  configPath: string;
  changed: number;
  baseUrl: string;
  format: "json" | "yaml";
}

function continueDir(): string {
  return path.join(os.homedir(), ".continue");
}

function isYaml(p: string): boolean {
  return /\.ya?ml$/i.test(p);
}

/**
 * Resolve which config file to edit.
 *  - explicit override wins (dispatched by its extension)
 *  - else prefer config.yaml (newer default), then config.json
 */
function resolveConfigPath(): string {
  const override = vscode.workspace
    .getConfiguration("paritok")
    .get<string>("assistantConfigPath", "");
  if (override && override.trim()) {
    return override.trim();
  }
  const yamlPath = path.join(continueDir(), "config.yaml");
  const jsonPath = path.join(continueDir(), "config.json");
  if (fs.existsSync(yamlPath)) {
    return yamlPath;
  }
  return jsonPath; // default target even if absent, so errors name the classic path
}

export function detectAssistant(): {
  jsonExists: boolean;
  yamlExists: boolean;
  target: string;
} {
  const jsonPath = path.join(continueDir(), "config.json");
  const yamlPath = path.join(continueDir(), "config.yaml");
  return {
    jsonExists: fs.existsSync(jsonPath),
    yamlExists: fs.existsSync(yamlPath),
    target: resolveConfigPath(),
  };
}

function parse(raw: string, asYaml: boolean): any {
  return asYaml ? yaml.load(raw) : JSON.parse(raw);
}

/** True if the config already has a model for the wanted upstream provider. */
export function hasMatchingModel(upstream: string): boolean {
  const wanted = upstream === "openai" ? "openai" : "anthropic";
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    return false;
  }
  try {
    const cfg = parse(fs.readFileSync(configPath, "utf8"), isYaml(configPath));
    const models: any[] = Array.isArray(cfg?.models) ? cfg.models : [];
    return models.some((m) => m && m.provider === wanted);
  } catch {
    return false;
  }
}

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-3-5-sonnet-latest",
  openai: "gpt-4o",
};

/**
 * Ensure a model for the wanted provider exists in the assistant config,
 * prompting for the model id + upstream API key and appending an entry if not.
 * The new entry uses the provider's default endpoint (no apiBase) — `wire()`
 * flips its apiBase to the proxy afterwards. Persists across disable, since it's
 * written before wire() takes its backup.
 *
 * Returns true if a matching model exists (already or newly created), false if
 * the user cancelled.
 */
export async function ensureModel(upstream: string): Promise<boolean> {
  if (hasMatchingModel(upstream)) {
    return true;
  }
  const wanted = upstream === "openai" ? "openai" : "anthropic";

  const model = await vscode.window.showInputBox({
    prompt: `Model id for your ${wanted} model in Continue`,
    value: DEFAULT_MODEL[wanted],
    ignoreFocusOut: true,
  });
  if (!model) {
    return false;
  }
  const apiKey = await vscode.window.showInputBox({
    prompt: `Your ${wanted} API key (kept in Continue's config, forwarded to the provider)`,
    placeHolder: wanted === "openai" ? "sk-..." : "sk-ant-...",
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) {
    return false;
  }

  const configPath = resolveConfigPath();
  const asYaml = isYaml(configPath);
  let cfg: any = { name: "Main Config", version: "1.0.0", schema: "v1", models: [] };
  if (fs.existsSync(configPath)) {
    try {
      cfg = parse(fs.readFileSync(configPath, "utf8"), asYaml) || cfg;
    } catch (e: any) {
      throw new Error(`Could not parse ${configPath}: ${e.message}`);
    }
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }
  if (!Array.isArray(cfg.models)) {
    cfg.models = [];
  }
  cfg.models.push({
    name: `Paritok (${wanted})`,
    provider: wanted,
    model,
    apiKey: apiKey.trim(),
    roles: ["chat", "edit", "apply"],
  });
  fs.writeFileSync(configPath, serialize(cfg, asYaml), "utf8");
  return true;
}

function serialize(cfg: any, asYaml: boolean): string {
  return asYaml
    ? yaml.dump(cfg, { lineWidth: 120, noRefs: true })
    : JSON.stringify(cfg, null, 2);
}

/**
 * Redirect matching models to `baseUrl`. Returns how many entries changed.
 * Throws with an actionable message when the config is missing or unparseable.
 */
export function wire(baseUrl: string, upstream: string): WireResult {
  const configPath = resolveConfigPath();
  const asYaml = isYaml(configPath);
  const format: "json" | "yaml" = asYaml ? "yaml" : "json";

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Continue config not found at ${configPath}. Install the Continue ` +
        `extension and add at least one model, or set paritok.assistantConfigPath.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let cfg: any;
  try {
    cfg = parse(raw, asYaml);
  } catch (e: any) {
    throw new Error(`Could not parse ${configPath} as ${format.toUpperCase()}: ${e.message}`);
  }
  if (!cfg || typeof cfg !== "object") {
    throw new Error(`${configPath} did not contain a config object.`);
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
    // Nothing matched — drop the backup so Disable doesn't "restore" a no-op.
    fs.rmSync(configPath + BACKUP_SUFFIX, { force: true });
    throw new Error(
      `No '${wanted}' models found in ${configPath} to redirect. Add a ` +
        `${wanted} model in Continue first, or switch paritok.upstream.`
    );
  }

  fs.writeFileSync(configPath, serialize(cfg, asYaml), "utf8");
  return { configPath, changed, baseUrl, format };
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
