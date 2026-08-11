import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import * as http from "http";
import { spawnCmd, runCheck, killTree, killByCommandLine } from "./proc";

// Every proxy the extension spawns is passed a --config-file inside this
// globalStorage folder, so its command line uniquely contains this string.
// We reap by matching it, which never touches a `paritok up` the user ran
// themselves (that uses a different config path).
const REAP_FRAGMENT = "paritok.paritok-vscode";

/**
 * Owns the lifetime of the local `paritok up` process.
 *
 * The extension is NOT in the request path — it only launches this process and
 * points the assistant's base_url at it. Once running, the assistant talks to
 * the proxy directly; this class just starts it, health-checks it, and kills it
 * on shutdown.
 */
export class ProxyManager {
  private proc: ChildProcess | null = null;
  private readonly out: vscode.OutputChannel;

  constructor(out: vscode.OutputChannel) {
    this.out = out;
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  get host(): string {
    return vscode.workspace.getConfiguration("paritok").get<string>("host", "127.0.0.1");
  }

  get port(): number {
    return vscode.workspace.getConfiguration("paritok").get<number>("port", 8080);
  }

  private get command(): string {
    return vscode.workspace
      .getConfiguration("paritok")
      .get<string>("paritokCommand", "paritok");
  }

  /** Resolve the base URL the assistant should call, per the upstream setting. */
  baseUrl(): string {
    const upstream = vscode.workspace
      .getConfiguration("paritok")
      .get<string>("upstream", "anthropic");
    const root = `http://${this.host}:${this.port}`;
    return upstream === "openai" ? `${root}/v1` : root;
  }

  /** True if the paritok CLI is runnable (handles Windows .cmd launchers). */
  checkInstalled(): Promise<boolean> {
    return runCheck(this.command, ["--version"]);
  }

  /**
   * Start the proxy with the given config file and wait until /health responds.
   * Rejects with an actionable message if the binary is missing or never comes up.
   */
  async start(configPath: string): Promise<void> {
    if (this.running) {
      return;
    }
    // If something is already serving /health on this port (e.g. a `paritok up`
    // the user launched in a terminal), reuse it instead of spawning a second
    // proxy that would fight for the port.
    if (await this.pingHealth()) {
      this.out.appendLine(`[reusing an existing proxy already on ${this.host}:${this.port}]`);
      return;
    }
    if (!(await this.checkInstalled())) {
      throw new Error(
        `The 'paritok' CLI was not found (tried '${this.command}'). ` +
          `Install it with:  pip install "paritok[proxy]"  — or set ` +
          `paritok.paritokCommand to its absolute path.`
      );
    }

    const args = [
      "up",
      "--host",
      this.host,
      "--port",
      String(this.port),
      "--config-file",
      configPath,
    ];
    this.out.appendLine(`$ ${this.command} ${args.join(" ")}`);

    this.proc = spawnCmd(this.command, args, {
      // Inherit the environment so PARITOK_API_KEY / proxy vars still apply.
      env: process.env,
    });
    this.proc.stdout?.on("data", (d) => this.out.append(d.toString()));
    this.proc.stderr?.on("data", (d) => this.out.append(d.toString()));
    this.proc.on("exit", (code) => {
      this.out.appendLine(`\n[paritok exited with code ${code}]`);
      this.proc = null;
    });

    await this.waitForHealth(30_000);
  }

  /** One-shot GET /health — true if something healthy already answers. */
  private pingHealth(): Promise<boolean> {
    const { host, port } = this;
    return new Promise((resolve) => {
      const req = http.get({ host, port, path: "/health", timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /** Poll GET /health until 200 or timeout. */
  private waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const host = this.host;
    const port = this.port;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!this.running) {
          return reject(new Error("The proxy process exited during startup — see the Paritok output channel."));
        }
        const req = http.get({ host, port, path: "/health", timeout: 2000 }, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            return resolve();
          }
          retry();
        });
        req.on("error", retry);
        req.on("timeout", () => {
          req.destroy();
          retry();
        });
      };
      const retry = () => {
        if (Date.now() > deadline) {
          return reject(new Error("Proxy did not become healthy within 30s."));
        }
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  /** Fetch and return the /stats JSON as a pretty string. */
  fetchStats(): Promise<string> {
    const host = this.host;
    const port = this.port;
    return new Promise((resolve, reject) => {
      const req = http.get({ host, port, path: "/stats", timeout: 3000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    });
  }

  stop(): void {
    if (this.proc) {
      this.out.appendLine("\n[stopping paritok]");
      killTree(this.proc);
      this.proc = null;
    }
    // Sweep any orphan we (or a previous session) spawned but didn't track —
    // matches only OUR config path, so a user-run `paritok up` is left alone.
    killByCommandLine(REAP_FRAGMENT);
  }

  /**
   * Kill leftover proxies the extension spawned in a previous session (e.g. one
   * orphaned by an abrupt VS Code close). Call at activation, before anything
   * else, to guarantee no zombie survives a restart. Never touches a proxy the
   * user started themselves.
   */
  reapOrphans(): void {
    killByCommandLine(REAP_FRAGMENT);
  }
}
