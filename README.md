# Paritok for VS Code

**Route your coding agents through a local [Paritok](https://paritok.com) proxy so tool-call and file context gets compressed before it reaches the model — cutting token cost without changing how you work.**

One command, pick your agents:

- **Claude Code** — subscription **or** API key. No key needed here; wires `~/.claude/settings.json`.
- **Codex** — paritok writes `~/.codex/config.toml` for you.
- **Continue** — API-key assistant; creates/redirects a model in `~/.continue/config.*`.

The extension is a **thin launcher + wiring layer**. It never intercepts traffic
and re-implements no compression logic — tool filtering, history compression, and
context recall all stay server-side in the paritok proxy. The extension only:

1. starts a local `paritok up` process, and
2. points each agent's config at it,

then gets out of the way.

```
Claude Code / Codex / Continue ──► paritok up (127.0.0.1:8080) ──compressed──► Anthropic / OpenAI
   ▲                                                                                  │
   └──────────────────────────────────── response ◄───────────────────────────────────┘
```

## Quick start

1. Install this extension.
2. Run **`Paritok: Set API Key`** and paste your Paritok key (free at [paritok.com](https://paritok.com)).
3. Run **`Paritok: Enable`** → tick the agents you use → confirm.
4. Follow the per-agent hint (reload window / restart Claude Code / run `codex`).

Detected agents are pre-checked, and anything missing (the paritok CLI, Continue) is offered for one-click install. The status bar shows `🔌 paritok :8080 (n)`.

## Per-agent notes

| Agent | What you need | What the extension writes |
|---|---|---|
| **Claude Code** | Nothing extra — works with your **subscription** | `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` |
| **Codex** | An OpenAI key (or `OPENAI_API_KEY` in env) | paritok generates `~/.codex/config.toml` |
| **Continue** | An upstream API key (`sk-ant-…` / `sk-…`) | creates/redirects a model in `~/.continue/config.*` |

**`Paritok: Disable`** stops the proxy and restores every agent's original config
from its byte-for-byte backup.

## Commands

| Command | What it does |
|---|---|
| `Paritok: Set API Key` | Store your Paritok key (VS Code SecretStorage). |
| `Paritok: Enable` | Pick agents, ensure the CLI, start the proxy, wire them. |
| `Paritok: Disable` | Stop the proxy, restore all agent configs. |
| `Paritok: Restart` | Disable then Enable. |
| `Paritok: Install CLI (pip)` | Install the paritok CLI via `pip` (needs Python). |
| `Paritok: Show Savings (/stats)` | Open the proxy's live `/stats`. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `paritok.host` | `127.0.0.1` | Host the proxy binds to. |
| `paritok.port` | `8080` | Port the proxy listens on. |
| `paritok.upstream` | `anthropic` | **Continue only** — `anthropic` → base `http://host:port`; `openai` → `…/v1`. |
| `paritok.codexModel` | `gpt-5` | **Codex only** — model id written into `~/.codex/config.toml`. |
| `paritok.paritokCommand` | `paritok` | Path to the paritok CLI if not on PATH. |
| `paritok.pythonCommand` | `""` | Python launcher for the pip install (auto-detects otherwise). |
| `paritok.autoStart` | `false` | Re-enable the previously chosen agents on startup. |
| `paritok.assistantConfigPath` | `""` | Override the Continue config location. |

## Requirements

- **Python + the paritok CLI** (`pip install "paritok[proxy]"`) — the extension offers to install the CLI for you if Python is present.
- At least one supported agent: **Claude Code**, **Codex**, or **Continue**.

## Known limits

- **Cline / Roo / Cursor's built-in / JetBrains AI Assistant** are not wired — Claude Code, Codex, and Continue are the supported targets today.
- Paritok compresses **native tool-call / file-read context**; agents that inline file content as plain text see lower savings.

## Privacy

With the hosted backend, the segments paritok compresses are sent to
`www.paritok.com/api` for inference. Upstream provider credentials (your Claude
subscription, OpenAI key, …) are forwarded by the local proxy to the real
provider and are not stored by the extension beyond each agent's own config; the
Paritok key lives in VS Code SecretStorage.

## License

MIT © Paritok. The extension is open source; the Paritok API service is provided
under its own [Terms of Service](https://paritok.com/terms).
