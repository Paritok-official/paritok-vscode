import * as vscode from "vscode";
import { execFile, spawn } from "child_process";

/**
 * Best-effort auto-install of the paritok CLI via pip.
 *
 * What this CAN do: if Python + pip are present, run `pip install "paritok[proxy]"`
 * for the user (with their consent). What it CANNOT do: install Python itself —
 * that needs a system runtime + often admin rights, so we detect its absence and
 * point at python.org instead.
 */

const PY_CANDIDATES = ["python", "python3", "py"];

function tryVersion(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(!err));
  });
}

/** Return a working Python launcher, honoring paritok.pythonCommand, or null. */
export async function findPython(): Promise<string | null> {
  const override = vscode.workspace
    .getConfiguration("paritok")
    .get<string>("pythonCommand", "");
  if (override && override.trim()) {
    return (await tryVersion(override.trim(), ["--version"])) ? override.trim() : null;
  }
  for (const c of PY_CANDIDATES) {
    if (await tryVersion(c, ["--version"])) {
      return c;
    }
  }
  return null;
}

/**
 * Run `<python> -m pip install "paritok[proxy]"`, streaming to the output channel.
 * Resolves on exit code 0, rejects otherwise.
 */
export function pipInstall(python: string, out: vscode.OutputChannel): Promise<void> {
  const args = ["-m", "pip", "install", "--upgrade", "paritok[proxy]"];
  out.show(true);
  out.appendLine(`$ ${python} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const proc = spawn(python, args, { env: process.env, shell: false });
    proc.stdout?.on("data", (d) => out.append(d.toString()));
    proc.stderr?.on("data", (d) => out.append(d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("exit", (code) => {
      if (code === 0) {
        out.appendLine("\n[pip install succeeded]");
        resolve();
      } else {
        reject(new Error(`pip exited with code ${code} — see the Paritok output channel.`));
      }
    });
  });
}

/**
 * Interactive install flow: prompt for consent, locate Python, run pip.
 * Returns true if paritok got installed (or the user should retry), false if the
 * user declined. Throws only on an unexpected failure the caller should surface.
 */
export async function offerInstall(out: vscode.OutputChannel): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "The paritok CLI is not installed. Install it now with pip?",
    { modal: true, detail: 'Runs:  pip install "paritok[proxy]"  (requires Python).' },
    "Install with pip"
  );
  if (choice !== "Install with pip") {
    return false;
  }

  const python = await findPython();
  if (!python) {
    const go = await vscode.window.showErrorMessage(
      "Python was not found. Install Python 3 (tick “Add Python to PATH”), then try again.",
      "Open python.org"
    );
    if (go === "Open python.org") {
      vscode.env.openExternal(vscode.Uri.parse("https://www.python.org/downloads/"));
    }
    return false;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Paritok: installing CLI via pip…" },
    () => pipInstall(python, out)
  );
  return true;
}
