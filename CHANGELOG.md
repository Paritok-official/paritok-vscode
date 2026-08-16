# Changelog

## 0.1.23

- **Disable now offers a one-click Reload Window for Claude Code.** A `claude` session started while routing was on captured `ANTHROPIC_BASE_URL=<proxy>` in its own process env at spawn time — which the OS won't let us change after the fact. So after **Paritok: Disable** stops the proxy, that still-open session would hit the dead port on its next request (`Connection refused`). Disable now warns and offers **Reload Window**, which respawns `claude` with the routing cleared, fully disconnecting it. Mirrors the reload prompt Enable already shows.

## 0.1.22

- **Docs & license.** Shortened the README to a short intro + per-agent quick start (Set API Key → Enable X), self-hosting via an editable config (`use_gpu_server: false`), and a **See your savings** note (`http://127.0.0.1:8080/stats`). Relicensed from MIT to **Apache-2.0**. No functional changes.

## 0.1.21

- **Backend readiness check before Enable — no more silent "why isn't it compressing?".** Enabling an agent now preflights the configured backend:
  - **GPU server (`use_gpu_server: true`, the default):** if no Paritok API key is set, or the server rejects it (invalid/expired), you get a warning with **Set API Key** (instead of silently passing through uncompressed).
  - **Local Ollama (`use_gpu_server: false`):** if Ollama isn't reachable, a warning offers to open the **Ollama download page**; if it's running but the `paritok-4b-v1` model isn't pulled, a **Pull Model** button runs `ollama pull paritok-4b-v1` in a terminal.
- **Local Ollama needs no Paritok key.** When `use_gpu_server: false`, Enable no longer prompts for (or requires) a Paritok API key — the local model is keyless. GPU mode is unchanged.
- (Reminder: Enable already offers to `pip install "paritok[proxy]"` for you when the CLI is missing — that's unchanged.)

## 0.1.20

- **Codex/Continue never get stranded on a dead proxy.** They write persistent configs pointing at the local proxy, so a crash or force-quit (where `deactivate` never runs) could leave them pointing at a dead port. Now, on every launch, if any agent is enabled the extension re-establishes the proxy — and if it can't start, it **restores** those configs so nothing dangles. A normal close still restores them via `deactivate`. (`paritok.autoStart` is now redundant and marked deprecated.)

## 0.1.19

- **Slimmer Codex config.** The generated paritok.yaml codex block is now just `enabled: true` (plus `model` only if you pinned one via `paritok.codexModel`). No `subscription`/`api_key` — Codex uses its own login (subscription or key via `codex login`) and paritok relays it, exactly like Claude Code. The full "Create editable config" template drops those lines too. (Needs paritok ≥ 1.3.4, which defaults Codex auth to `requires_openai_auth`.)

## 0.1.18

- **Don't force a Codex model.** `paritok.codexModel` now defaults to empty, and the generated config omits the `model =` line — so Codex uses its own model selection (its picker, `-m/--model`, or default). A hardcoded `gpt-5` was rejected by ChatGPT-account Codex ("model not supported"). Set `paritok.codexModel` only if you want to pin one. (Needs paritok ≥ 1.3.4.)

## 0.1.17

- **Codex enable is now as simple as Claude Code — no auth prompt.** Codex already lets you sign in (ChatGPT subscription or API key) in its own panel / via `codex login`, so the extension no longer asks. It always writes `requires_openai_auth`, and the proxy routes by token type (OAuth → ChatGPT backend, `sk-` key → OpenAI). Enable Codex now also offers **Reload Window** (a new Codex session is needed to pick up the config, same as Claude Code). To embed a raw API key instead, use a self-managed config (`paritok.configFile`).

## 0.1.16

- **Full engine settings in VS Code.** The Settings UI now mirrors paritok.yaml: backend (`useGpuServer`, gpu_server/local_model base URLs, models, timeouts), `compression` (min/max tokens, refusal threshold), `history` (keep-recent-turns, context threshold/window), `tool_discovery` (strategy, top_k, k_max, adaptive, MCP threshold), `trace`, and `shadow_storage`. Only settings you actually change are written into the generated config — anything untouched still falls back to paritok's own defaults. (For hand-editing the raw file instead, `paritok.configFile` + Open Config still apply and take precedence.)

## 0.1.15

- **New: `Paritok: Open Config (paritok.yaml)`.** Opens the active config so you can reach settings the UI doesn't expose — `use_gpu_server`, timeouts, `compression`, `history`, `tool_discovery`, `trace`, `shadow_storage`, and the full `codex` block.
- **Self-managed config.** New `paritok.configFile` setting: point it at your own paritok.yaml and the extension uses it AS-IS and never overwrites it. Opening the managed config offers a one-click "Create editable config" that seeds a full, commented template and switches you to it. (The default managed config is still regenerated on each Enable — the command warns you before you edit it.)

## 0.1.14

- **Codex can now use your ChatGPT subscription — no API key.** Enabling Codex asks how to authenticate: **ChatGPT subscription** (recommended; run `codex login` once, nothing to paste) or **OpenAI API key**. Subscription routing needs paritok ≥ 1.3.4 (the proxy forwards the ChatGPT OAuth token to the ChatGPT backend). Requires the matching `subscription` flag written into paritok.yaml, which this version now emits.

## 0.1.13

- **Codex now covers the VS Code panel too, automatically.** OpenAI's "Codex" extension (`openai.chatgpt`) spawns `codex` with `CODEX_HOME=~/.codex`, so it reads the same `config.toml` paritok generates — enabling Codex routes both the terminal `codex` and the Codex panel, no extra setup. Detection now also recognises the extension (not just the CLI), so panel-only users aren't wrongly told "not detected". Start a new Codex session after enabling to pick it up.

## 0.1.12

- **Reload Window now reliably re-routes Claude Code.** The routing env var is set on the *very first line* of activation (from stored state + config, fully synchronous) — before the output channel, the proxy, anything — so the native Claude Code extension inherits it whenever it spawns, winning the reload race. "Reload Window" is back as the one-click path after enabling (starting a new session still works too).
- Command renamed `Paritok: Enable Claude Code` (dropped the parenthetical).

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
