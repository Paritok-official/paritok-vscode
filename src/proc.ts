import { spawn, spawnSync, ChildProcess, SpawnOptions } from "child_process";

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
 * Run a command and capture its stdout+stderr. Resolves the combined text on
 * exit 0, or null on spawn error / non-zero exit. Never rejects. Used to read
 * `paritok --version` for the outdated-CLI check.
 */
export function runCapture(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = "";
    const child = spawnCmd(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d) => (buf += d.toString()));
    child.stderr?.on("data", (d) => (buf += d.toString()));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? buf : null));
  });
}

/**
 * Kill a spawned process and its children. On Windows a shell-launched tree
 * (cmd.exe → paritok.cmd → python) is not fully killed by proc.kill(), so use
 * taskkill /T. IMPORTANT: this is SYNCHRONOUS (spawnSync). We used to fire an
 * async taskkill, but when this runs from deactivate() on VS Code close, the
 * extension host is torn down before the async taskkill finishes — leaving the
 * python grandchild orphaned and still listening on the port. Blocking here
 * guarantees the tree is dead before deactivate() returns.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (isWin) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* best-effort */
    }
  } else {
    try {
      child.kill();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Synchronously kill any process whose command line contains `fragment`.
 * Used to reap orphaned proxies the extension spawned in a previous session
 * (their `--config-file` path contains our globalStorage folder name), which a
 * crash or abrupt close can leave behind. Matching on the config path means we
 * never touch a `paritok up` the user started themselves in a terminal.
 */
export function killByCommandLine(fragment: string): void {
  try {
    if (isWin) {
      const ps =
        "Get-CimInstance Win32_Process | " +
        `Where-Object { $_.CommandLine -like '*${fragment}*' } | ` +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      spawnSync("pkill", ["-f", fragment], { stdio: "ignore" });
    }
  } catch {
    /* best-effort */
  }
}
