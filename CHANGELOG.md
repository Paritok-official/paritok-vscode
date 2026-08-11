# Changelog

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
