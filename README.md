# Paritok for VS Code

**Route your in-editor AI assistant through a local [Paritok](https://paritok.com) proxy so tool-call and file context gets compressed before it reaches the model — cutting token cost without changing how you work.**

This extension is a **thin launcher + wiring layer**. It does not re-implement any
compression logic. All of Paritok's intelligence — tool filtering, history
compression, context recall/expansion — stays in the Python proxy and runs
server-side. The extension only:

1. starts a local `paritok up` proxy process, and
2. points your assistant's base URL at it,

then gets out of the way. Once wired, your assistant talks to the proxy directly;
the extension is **not** in the request path.

```
Continue ──request──► paritok up (127.0.0.1:8080) ──compressed──► OpenAI / Anthropic
   ▲                                                                    │
   └──────────────────────────── response ◄─────────────────────────────┘
   (the extension only started the proxy and set Continue's base_url — it does not relay traffic)
```

## Requirements

- **Python + the paritok CLI**: `pip install "paritok[proxy]"` (the extension checks and tells you if it's missing).
- **A supported assistant that allows a custom API base URL** — currently **[Continue](https://continue.dev)** (classic `config.json`). Cline/Roo work the same way but must be wired by hand for now (see *Known limits*).
- **A Paritok API key** — free at [paritok.com](https://paritok.com) → dashboard → API keys.

## Setup (one time)

1. Install this extension.
2. Install **Continue** and add at least one model (Anthropic or OpenAI) with your normal upstream API key.
3. Run **`Paritok: Set API Key`** and paste your Paritok key.
4. Run **`Paritok: Enable Proxy Mode`**.
5. Click **Reload Window** when prompted (so Continue picks up the new endpoint).

Done. The status bar shows `🔌 paritok :8080`. Use Continue exactly as before — traffic now flows through the compressor.

## What "Enable Proxy Mode" does

- Writes a minimal `paritok.yaml` (hosted GPU backend + your key) into the extension's storage.
- Spawns `paritok up --host <host> --port <port> --config-file <that yaml>` and waits for `/health`.
- **Backs up your Continue `config.json` byte-for-byte**, then rewrites the `apiBase` of each matching (`anthropic` or `openai`) model to `http://127.0.0.1:8080` (or `…/v1` for OpenAI). Your upstream API keys are left untouched — Paritok forwards the `Authorization` header straight to the real provider.

**`Paritok: Disable Proxy Mode`** stops the proxy and restores the exact original config from the backup.

## Commands

| Command | What it does |
|---|---|
| `Paritok: Set API Key` | Store your Paritok key (VS Code SecretStorage). |
| `Paritok: Enable Proxy Mode` | Start proxy + wire Continue. |
| `Paritok: Disable Proxy Mode` | Stop proxy + restore original config. |
| `Paritok: Restart Proxy` | Disable then enable. |
| `Paritok: Show Savings (/stats)` | Open the proxy's live `/stats` JSON. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `paritok.host` | `127.0.0.1` | Host the proxy binds to. |
| `paritok.port` | `8080` | Port the proxy listens on. |
| `paritok.upstream` | `anthropic` | `anthropic` → base `http://host:port`; `openai` → `http://host:port/v1`. |
| `paritok.paritokCommand` | `paritok` | Path to the paritok CLI if not on PATH. |
| `paritok.autoStart` | `false` | Enable proxy mode on VS Code startup (needs a stored key). |
| `paritok.assistantConfigPath` | `""` | Override the Continue `config.json` location. |

## Known limits

- **Continue `config.yaml` (newer format) and Cline** are *detected but not auto-edited* — the extension refuses to edit YAML rather than risk corrupting it. Wire them by hand: set the model's `apiBase` to the URL shown in the enable notification.
- **Copilot / Cursor's built-in / JetBrains AI Assistant** do **not** expose a custom base URL, so they cannot be routed this way. This extension targets assistants that do.
- Paritok compresses **native tool-call / file-read context**. Assistants that stuff file content into plain user text (not via tools) will see lower savings — same rule as the CLI.

## Privacy

With the hosted backend (`use_gpu_server: true`), the segments Paritok compresses
are sent to `www.paritok.com/api` for inference. Your upstream provider key is
forwarded by the local proxy to the real provider and is **not** stored by the
extension beyond your assistant's own config. The Paritok key is kept in VS Code
SecretStorage.

## License

MIT © Paritok. The extension is open source; the Paritok API service is provided
under its own [Terms of Service](https://paritok.com/terms).
