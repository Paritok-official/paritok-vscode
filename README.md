# Paritok for VS Code

Route your coding agent (Claude Code / Codex / Continue) through a local **Paritok** proxy that compresses tool-call and file context before it reaches the model — cutting token cost without changing how you work.

The extension is just a launcher: it starts a local `paritok up` process and points your agent's config at it. All compression stays server-side.

**Main project & docs:** https://github.com/Paritok-official/paritok-4b-v1

## Install & use

After installing the extension:

**Claude Code**
1. `Ctrl+Shift+P` → **`Paritok: Set API Key`** → paste your Paritok key (free until end of August at [paritok.com](https://paritok.com)).
2. `Ctrl+Shift+P` → **`Paritok: Enable Claude Code`** → done.

**Codex** — same, but step 2 is **`Paritok: Enable Codex`**.

**Continue** — same, but step 2 is **`Paritok: Enable Continue`**.

## Self-hosting (no API key)

Prefer to run the open model locally instead of the Paritok GPU server?

1. `Ctrl+Shift+P` → **`Paritok: Open Config`** → click **Create editable config**, then set **`use_gpu_server: false`** in the yaml and save (this switches the proxy to your local Ollama at `http://localhost:11434`).
2. `Ctrl+Shift+P` → **`Paritok: Enable Claude Code`** (or Codex / Continue). No API key needed.

## See your savings

While the proxy is running, open **http://127.0.0.1:8080/stats** in a browser (or run `Ctrl+Shift+P` → **`Paritok: Show Savings (/stats)`**) to see live compression data — tokens in/out, tokens saved, and the compression ratio.

## Disable

`Ctrl+Shift+P` → **`Paritok: Disable`** stops the proxy and restores every agent's original config.

## Requirements

- **Python** — the paritok CLI is installed for you on first Enable.
- At least one of: **Claude Code**, **Codex**, or **Continue**.

## License

Apache-2.0 © Paritok. The Paritok API service is provided under its own [Terms of Service](https://paritok.com/terms).
