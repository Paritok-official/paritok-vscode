import * as vscode from "vscode";
import { ProxyManager } from "./proxyManager";
import { writeProxyConfig } from "./paritokConfig";
import * as assistant from "./assistantConfig";

const SECRET_KEY = "paritok.apiKey";

let proxy: ProxyManager;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Paritok");
  proxy = new ProxyManager(output);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "paritok.showStats";
  context.subscriptions.push(output, status);
  render();

  context.subscriptions.push(
    vscode.commands.registerCommand("paritok.setApiKey", () => setApiKey(context)),
    vscode.commands.registerCommand("paritok.enableProxyMode", () => enable(context)),
    vscode.commands.registerCommand("paritok.disableProxyMode", () => disable()),
    vscode.commands.registerCommand("paritok.restartProxy", async () => {
      await disable();
      await enable(context);
    }),
    vscode.commands.registerCommand("paritok.showStats", () => showStats())
  );

  // Optional auto-start on launch, only if a key is already stored.
  const auto = vscode.workspace.getConfiguration("paritok").get<boolean>("autoStart", false);
  if (auto && (await context.secrets.get(SECRET_KEY))) {
    enable(context).catch((e) => output.appendLine(`auto-start failed: ${e.message}`));
  }
}

export async function deactivate() {
  // Best-effort cleanup: restore the assistant config and kill the proxy so we
  // never leave the user pointed at a dead port.
  try {
    assistant.unwire();
  } catch {
    /* ignore */
  }
  proxy?.stop();
}

async function setApiKey(context: vscode.ExtensionContext) {
  const value = await vscode.window.showInputBox({
    prompt: "Paritok API key (create one at paritok.com → dashboard → API keys)",
    placeHolder: "pk_live_...",
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return; // cancelled
  }
  if (!value.trim()) {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage("Paritok API key cleared.");
    return;
  }
  await context.secrets.store(SECRET_KEY, value.trim());
  vscode.window.showInformationMessage("Paritok API key saved.");
}

async function enable(context: vscode.ExtensionContext) {
  try {
    const key = await context.secrets.get(SECRET_KEY);
    if (!key) {
      const pick = await vscode.window.showWarningMessage(
        "No Paritok API key set. Set one now?",
        "Set API Key"
      );
      if (pick === "Set API Key") {
        await setApiKey(context);
      }
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Paritok: enabling proxy mode" },
      async (p) => {
        p.report({ message: "writing config…" });
        const cfgPath = await writeProxyConfig(context, key);

        p.report({ message: "starting proxy…" });
        await proxy.start(cfgPath);

        p.report({ message: "wiring assistant…" });
        const upstream = vscode.workspace
          .getConfiguration("paritok")
          .get<string>("upstream", "anthropic");
        const res = assistant.wire(proxy.baseUrl(), upstream);

        render();
        const reload = await vscode.window.showInformationMessage(
          `Paritok proxy running on ${proxy.baseUrl()} — redirected ${res.changed} ` +
            `${upstream} model(s) in Continue. Reload the window so Continue picks up the new endpoint.`,
          "Reload Window"
        );
        if (reload === "Reload Window") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      }
    );
  } catch (e: any) {
    // If wiring failed after the proxy came up, leave the proxy running (the user
    // may wire manually) but surface the reason.
    render();
    vscode.window.showErrorMessage(`Paritok: ${e.message}`);
    output.appendLine(`enable failed: ${e.stack || e.message}`);
  }
}

async function disable() {
  const restored = (() => {
    try {
      return assistant.unwire();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Paritok: could not restore config — ${e.message}`);
      return false;
    }
  })();
  proxy.stop();
  render();
  vscode.window.showInformationMessage(
    restored
      ? "Paritok proxy stopped and Continue config restored."
      : "Paritok proxy stopped. (No config backup to restore.)"
  );
}

async function showStats() {
  if (!proxy.running) {
    vscode.window.showInformationMessage("Paritok proxy is not running. Run 'Paritok: Enable Proxy Mode'.");
    return;
  }
  try {
    const stats = await proxy.fetchStats();
    let pretty = stats;
    try {
      pretty = JSON.stringify(JSON.parse(stats), null, 2);
    } catch {
      /* leave as-is */
    }
    const doc = await vscode.workspace.openTextDocument({ content: pretty, language: "json" });
    vscode.window.showTextDocument(doc, { preview: true });
  } catch (e: any) {
    vscode.window.showErrorMessage(`Paritok: could not fetch /stats — ${e.message}`);
  }
}

function render() {
  if (proxy?.running) {
    status.text = `$(plug) paritok :${proxy.port}`;
    status.tooltip = `Paritok proxy running on ${proxy.baseUrl()} — click for /stats`;
    status.backgroundColor = undefined;
  } else {
    status.text = `$(circle-slash) paritok off`;
    status.tooltip = "Paritok proxy stopped — run 'Paritok: Enable Proxy Mode'";
  }
  status.show();
}
