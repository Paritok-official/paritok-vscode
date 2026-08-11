import { spawn, ChildProcess, SpawnOptions } from "child_process";

/**
 * Cross-platform process helpers.
 *
 * The important Windows detail: pip installs console scripts as `.cmd`/`.bat`
 * launchers (e.g. paritok.cmd), and Node cannot execute those without a shell.
 * So on win32 we always spawn through the shell and quote args ourselves; on
 * POSIX we pass the argv array directly (no shell, no quoting pitfalls).
 */
export const isWin = process.platform === "win32";

/** Quote a single argument for cmd.exe when we build a shell command line. */
function quoteWin(a: string): string {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

/** Spawn `cmd args…`, resolving PATH launchers (incl. .cmd/.bat) on Windows. */
export function spawnCmd(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {}
): ChildProcess {
  if (isWin) {
    const line = [cmd, ...args].map(quoteWin).join(" ");
    return spawn(line, { ...opts, shell: true });
  }
  return spawn(cmd, args, { ...opts, shell: false });
}

/** Run a command just to see if it succeeds (exit 0). Never rejects. */
export function runCheck(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnCmd(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Kill a spawned process and its children. On Windows a shell-launched process
 * tree (cmd.exe → python) is not fully killed by proc.kill(), so use taskkill /T.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (isWin) {
    // /T kills the whole tree, /F forces it. Best-effort; ignore failures.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    }).on("error", () => {});
  } else {
    child.kill();
  }
}
