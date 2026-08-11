# Changelog

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
