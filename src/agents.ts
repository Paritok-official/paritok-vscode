import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCheck } from "./proc";
import { CodexOptions } from "./paritokConfig";
import { ensureContinue } from "./installer";
import * as continueCfg from "./assistantConfig";

/**
 * A routable agent: something the user runs that talks to an LLM API and whose
 * endpoint we can point at the local proxy by editing ITS config file.
 *
 * Design: the extension never intercepts traffic. Each agent is wired by writing
 * its own config (byte-for-byte backed up), so Disable restores the exact
 * original. Codex is special — paritok itself writes ~/.codex/config.toml from
 * the paritok.yaml `codex:` block, so its `enable` is handled at proxy start and
 * this agent only owns detection + restore.
 */
export interface EnableCtx {
  /** http://host:port — Anthropic-style root (Claude Code, Continue anthropic). */
  baseAnthropic: string;
  /** http://host:port/v1 — OpenAI-style root (Continue openai). */
  baseOpenAIv1: string;
}

export interface Agent {
  id: AgentId;
  label: string;
  /** One-line hint shown in the picker. */
  detail: string;
  /** Is this agent present on this machine? */
  detect(): Promise<boolean>;
  /** Currently routed through the proxy? */
  isWired(): boolean;
  /**
   * Gather inputs needed to enable (keys/model), reusing stored secrets so we
   * don't re-prompt. Return the collected data, or undefined if the user
   * cancelled. Agents needing nothing return {}.
   */
  collect?(context: vscode.ExtensionContext): Promise<any | undefined>;
  /**
   * Wire the agent to the proxy. `collected` is whatever collect() returned.
   * Codex returns its CodexOptions here for the paritok.yaml (via codexOptions),
   * and does its actual wiring at proxy start — so its enable() is a no-op.
   */
  enable(ctx: EnableCtx, collected: any): Promise<void>;
  /** Restore the original config. */
  disable(): Promise<void>;
  /** True if enabling/disabling this agent requires (re)starting paritok. */
  viaProxy?: boolean;
  /** For Codex: expose the CodexOptions to fold into paritok.yaml. */
  codexOptions?: CodexOptions;
  /** Post-enable user hint (e.g. "reload window", "restart Claude Code"). */
  postEnableHint?: string;
}

export type AgentId = "claude-code" | "codex" | "continue";

const BAK = ".paritok-bak";

// ─────────────────────────────── Claude Code ───────────────────────────────
// Subscription-friendly: no API key. We set env.ANTHROPIC_BASE_URL in
// ~/.claude/settings.json, which both the CLI and the VS Code extension read.

function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

const claudeCode: Agent = {
  id: "claude-code",
  label: "Claude Code",
  detail: "Subscription or API key — no key needed here. Edits ~/.claude/settings.json.",
  viaProxy: false,
  postEnableHint: "Restart your Claude Code session (or reload the window) to pick up the new endpoint.",

  async detect(): Promise<boolean> {
    return (
      fs.existsSync(path.join(os.homedir(), ".claude")) ||
      !!vscode.extensions.getExtension("Anthropic.claude-code") ||
      (await runCheck("claude", ["--version"]))
    );
  },

  isWired(): boolean {
    const p = claudeSettingsPath();
    if (!fs.existsSync(p)) {
      return false;
    }
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      return !!cfg?.env?.ANTHROPIC_BASE_URL;
    } catch {
      return false;
    }
  },

  async collect(): Promise<any> {
    return {}; // nothing to gather — subscription needs no key
  },

  async enable(ctx: EnableCtx): Promise<void> {
    const p = claudeSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const raw = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "{}";
    if (fs.existsSync(p)) {
      fs.writeFileSync(p + BAK, raw, "utf8"); // byte-for-byte backup
    }
    let cfg: any;
    try {
      cfg = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`Could not parse ${p}: ${e.message}`);
    }
    cfg.env = { ...(cfg.env || {}), ANTHROPIC_BASE_URL: ctx.baseAnthropic };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
  },

  async disable(): Promise<void> {
    const p = claudeSettingsPath();
    if (fs.existsSync(p + BAK)) {
      fs.writeFileSync(p, fs.readFileSync(p + BAK, "utf8"), "utf8");
      fs.rmSync(p + BAK, { force: true });
      return;
    }
    // No backup (we created settings.json): just strip the key we added.
    if (fs.existsSync(p)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        if (cfg?.env) {
          delete cfg.env.ANTHROPIC_BASE_URL;
          if (Object.keys(cfg.env).length === 0) {
            delete cfg.env;
          }
        }
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
      } catch {
        /* leave as-is */
      }
    }
  },
};

// ─────────────────────────────────── Codex ─────────────────────────────────
// paritok writes ~/.codex/config.toml from the paritok.yaml codex: block, so
// enabling = restart proxy with codex enabled. Here we own detect + restore.

function codexTomlPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

const codex: Agent = {
  id: "codex",
  label: "Codex",
  detail: "OpenAI Codex CLI. paritok writes ~/.codex/config.toml for you.",
  viaProxy: true,
  postEnableHint: "Run `codex` in a terminal — it now routes through the proxy.",

  async detect(): Promise<boolean> {
    return (
      fs.existsSync(path.join(os.homedir(), ".codex")) ||
      (await runCheck("codex", ["--version"]))
    );
  },

  isWired(): boolean {
    const p = codexTomlPath();
    if (!fs.existsSync(p)) {
      return false;
    }
    try {
      const t = fs.readFileSync(p, "utf8");
      return t.includes('model_provider = "paritok"');
    } catch {
      return false;
    }
  },

  async collect(context: vscode.ExtensionContext): Promise<any> {
    const model =
      vscode.workspace.getConfiguration("paritok").get<string>("codexModel", "gpt-5") ||
      "gpt-5";
    let key = (await context.secrets.get("paritok.openaiKey")) || "";
    if (!key) {
      const entered = await vscode.window.showInputBox({
        prompt: "OpenAI API key for Codex (leave empty to use the OPENAI_API_KEY env var)",
        placeHolder: "sk-... (optional)",
        password: true,
        ignoreFocusOut: true,
      });
      if (entered === undefined) {
        return undefined; // cancelled
      }
      key = entered.trim();
      if (key) {
        await context.secrets.store("paritok.openaiKey", key);
      }
    }
    return { model, apiKey: key };
  },

  async enable(_ctx: EnableCtx, collected: any): Promise<void> {
    // Wiring happens when paritok starts (it writes config.toml). We only stash
    // the options so the orchestrator folds them into paritok.yaml.
    codex.codexOptions = { model: collected.model, apiKey: collected.apiKey };
  },

  async disable(): Promise<void> {
    const p = codexTomlPath();
    codex.codexOptions = undefined;
    if (fs.existsSync(p + BAK)) {
      fs.writeFileSync(p, fs.readFileSync(p + BAK, "utf8"), "utf8");
      fs.rmSync(p + BAK, { force: true });
      return;
    }
    // paritok generated it and there was no prior user config → remove it.
    if (fs.existsSync(p)) {
      try {
        if (fs.readFileSync(p, "utf8").includes("Generated by `paritok")) {
          fs.rmSync(p, { force: true });
        }
      } catch {
        /* leave as-is */
      }
    }
  },
};

// ────────────────────────────────── Continue ───────────────────────────────
// API-key editor assistant. Reuses assistantConfig (config.json/yaml wiring +
// model creation). Not subscription-capable — kept as an optional target.

const continueAgent: Agent = {
  id: "continue",
  label: "Continue",
  detail: "VS Code assistant (needs an API key). Edits ~/.continue/config.*",
  viaProxy: false,
  postEnableHint: "Reload the window so Continue picks up the new endpoint.",

  async detect(): Promise<boolean> {
    return continueCfg.continueInstalledOrConfigured();
  },

  isWired(): boolean {
    return continueCfg.isWired();
  },

  async collect(): Promise<any> {
    if (!continueCfg.continueInstalledOrConfigured()) {
      if (!(await ensureContinue())) {
        return undefined;
      }
    }
    const upstream = vscode.workspace
      .getConfiguration("paritok")
      .get<string>("upstream", "anthropic");
    if (!continueCfg.hasMatchingModel(upstream)) {
      const ok = await continueCfg.ensureModel(upstream);
      if (!ok) {
        return undefined;
      }
    }
    return { upstream };
  },

  async enable(ctx: EnableCtx, collected: any): Promise<void> {
    const upstream = collected.upstream as string;
    const base = upstream === "openai" ? ctx.baseOpenAIv1 : ctx.baseAnthropic;
    continueCfg.wire(base, upstream);
  },

  async disable(): Promise<void> {
    continueCfg.unwire();
  },
};

export const AGENTS: Agent[] = [claudeCode, codex, continueAgent];

export function agentById(id: AgentId): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}
