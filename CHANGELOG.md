# Changelog

## 0.1.11

- **Fix Claude Code routing UX.** An already-running Claude Code session keeps the endpoint it was spawned with, so enabling won't switch it — you must start a **new** session. The success message now says exactly that and no longer suggests "Reload Window" (reloading races the native extension's restart and often respawns the session before our env is set — which is why a reload appeared to "not work" but a fresh window did).
- On reload/restart, the routing env var is now set **synchronously at activation** (before any await) so a `claude` spawn during the same activation already inherits it.

## 0.1.10

- **Harden proxy shutdown further.** `deactivate()` now kills the proxy *first*, before any awaited config-restore work, so a short shutdown budget can't cut off the kill and orphan the process. Also registers a synchronous `process.on("exit")` cleanup as a last-ditch backstop when VS Code cuts `deactivate()` short. (Combined with 0.1.9's synchronous kill + activation-time reaping.)

## 0.1.9

- **Fix: orphaned `paritok up` left listening after VS Code closes.** On Windows the shutdown kill was fired asynchronously (`spawn` taskkill) from `deactivate()`, but the extension host is torn down before that async kill finishes — orphaning the python grandchild, which kept holding the port (and got silently reused on the next launch). The kill is now **synchronous** (`spawnSync`), so the whole tree is dead before `deactivate()` returns.
- **Reap orphans on activation.** As a backstop for crashes/force-quits (where `deactivate` never runs), the extension now kills any leftover proxy it spawned in a previous session at startup. It matches only processes launched with *our* globalStorage config path, so a `paritok up` you started yourself in a terminal is never touched.

## 0.1.8

- **Claude Code keeps its native panel.** 0.1.7 routed via a separate terminal (basically the CLI). Now routing is done by setting `ANTHROPIC_BASE_URL` **in the extension host's `process.env`** — the native Claude Code extension spawns `claude` with `{...process.env}`, and all desktop extensions share one host process, so a new Claude Code session picks it up with **zero config files touched**. It lives only in memory: closing VS Code clears it, so it can never leave a dead pointer on disk. Start a new session (or reload the window) after enabling. Re-established automatically after a window reload while enabled.
- The one-time `~/.claude/settings.json` self-heal from 0.1.7 stays, to clean up any injection left by ≤0.1.6.

## 0.1.7

- **Claude Code no longer touches `~/.claude/settings.json`.** The old design injected a persistent `ANTHROPIC_BASE_URL` there — which left Claude Code pointing at a dead port whenever the proxy wasn't running (after a VS Code restart/crash → "Connection refused"). Now **Paritok: Start Claude Code (routed terminal)** opens a dedicated integrated terminal that carries the endpoint in *its own process env* and runs `claude`. Close the terminal (or VS Code) and the routing is gone — zero residue, nothing to restore, impossible to leave Claude Code broken globally.
- **Self-heal on startup.** If a previous version left an `ANTHROPIC_BASE_URL` pointing at a local proxy in `~/.claude/settings.json`, it's removed (backup restored if present) the moment the extension activates — so upgraders are fixed automatically. Only localhost URLs are touched; a user's own remote base is left alone.
- **Per-agent commands — no more confusing multi-select.** Instead of one checklist where Enter confirmed *every* ticked agent (so ticking Claude Code also triggered Codex's key prompt), each agent now has its own command: **Start Claude Code**, **Enable Codex**, **Enable Continue**. `Paritok: Enable` is now a single-pick menu that dispatches to one of them.

> Note: for Claude Code's context meter to read correctly while routed, the paritok proxy needs a `/v1/messages/count_tokens` passthrough (tracked separately). Without it Claude Code can't measure remaining context and may compact early.

## 0.1.6

- **Fix: cancelling one agent no longer aborts the whole Enable.** Skipping (e.g. dismissing Codex's key prompt) now skips only that agent; the others — including Claude Code — still get wired.
- **Fix: safer Codex detection.** Codex is only auto-selected when the `codex` CLI is actually present, not merely because a `~/.codex` directory exists, so we never risk clobbering an unrelated config.
- **Reuse an existing proxy.** If a `paritok up` is already serving on the port (e.g. one you started in a terminal), Enable reuses it instead of spawning a second, conflicting proxy.

## 0.1.5

- **Multi-agent switch.** `Paritok: Enable` now offers a checklist of agents and wires the ones you pick, minimizing setup steps:
  - **Claude Code** — works with your **subscription** (no API key). Sets `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`.
  - **Codex** — paritok generates `~/.codex/config.toml` from the `codex:` block (asks for an OpenAI key once, or uses `OPENAI_API_KEY`).
  - **Continue** — unchanged (creates/redirects an API-key model).
- Detected agents are pre-checked; keys are stored and reused so re-enabling needs no re-entry.
- `Paritok: Disable` restores every wired agent's config from a byte-for-byte backup and remembers your selection across restarts (`autoStart`).
- Commands renamed: `Enable` / `Disable` / `Restart` (from the old `…ProxyMode`). New `paritok.codexModel` setting.

## 0.1.4

- **No more "No models found" dead-end.** A freshly installed Continue has an empty `models: []`. Enable Proxy Mode now offers to create a model for you — prompts for the model id (sensible default) and your upstream API key, writes it into Continue's config, then wires it. Also available as **Paritok: Add Model to Continue**.
- The created model persists across Disable Proxy Mode (only its `apiBase` is toggled).

## 0.1.3

- **Fix (Windows): "paritok CLI not found" even when installed.** pip installs the
  CLI as a `.cmd` launcher, which Node cannot run without a shell — so detection
  and startup wrongly reported it missing. All child processes now go through the
  shell on Windows (with proper arg quoting), so `.cmd`/`.bat` launchers on PATH
  work. Same fix applies to Python detection and the pip install step.
- Windows shutdown now kills the whole proxy process tree (`taskkill /T`) instead
  of leaking an orphaned `paritok up` after Disable Proxy Mode.

## 0.1.2

- **One-click Continue install.** If the Continue assistant isn't installed, Enable Proxy Mode now offers to install it from the Marketplace (consent prompt), so a cold-start user doesn't have to hunt for it. Also available as **Paritok: Install Continue**. (Soft, opt-in — not a hard `extensionDependencies`, so you stay free to uninstall.)
- After installing Continue you still add a model with your own upstream API key, then enable again.

## 0.1.1

- **One-click CLI install.** When the paritok CLI is missing, Enable Proxy Mode now offers to run `pip install "paritok[proxy]"` for you (consent prompt). Also available as the standalone command **Paritok: Install CLI (pip)**.
- Auto-detects a Python launcher (`python` / `python3` / `py`); override with the new `paritok.pythonCommand` setting. If Python itself is absent, points you to python.org (the extension cannot install Python).

## 0.1.0

Initial release — **Proxy Mode** (the "B1" approach).

- Start/stop a local `paritok up` process from within VS Code (lifecycle managed by the extension, killed on shutdown).
- Auto-wire Continue's classic `config.json`: byte-for-byte backup, redirect matching Anthropic/OpenAI models' `apiBase` to the local proxy, and restore on disable.
- Store the Paritok API key in VS Code SecretStorage; generate a minimal hosted-backend `paritok.yaml`.
- Status bar indicator + `/stats` viewer + `/health` startup gating.
- Optional `autoStart` on launch.

- Supports both Continue `config.json` and the newer `config.yaml` (YAML re-serialized while active; exact original restored from backup on disable).

### Known limits
- Cline / Roo store models in their own settings and must be wired by hand.
- Copilot / Cursor built-in / JetBrains AI Assistant cannot be routed (no custom base URL).
