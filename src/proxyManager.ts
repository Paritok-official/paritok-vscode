import * as vscode from "vscode";
import { spawn, ChildProcess, execFile } from "child_process";
import * as http from "http";

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

  /** True if the paritok CLI is importable/on PATH. */
  checkInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.command, ["--version"], (err) => resolve(!err));
    });
  }

  /**
   * Start the proxy with the given config file and wait until /health responds.
   * Rejects with an actionable message if the binary is missing or never comes up.
   */
  async start(configPath: string): Promise<void> {
    if (this.running) {
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

    this.proc = spawn(this.command, args, {
      // Inherit the environment so PARITOK_API_KEY / proxy vars still apply.
      env: process.env,
      shell: false,
    });
    this.proc.stdout?.on("data", (d) => this.out.append(d.toString()));
    this.proc.stderr?.on("data", (d) => this.out.append(d.toString()));
    this.proc.on("exit", (code) => {
      this.out.appendLine(`\n[paritok exited with code ${code}]`);
      this.proc = null;
    });

    await this.waitForHealth(30_000);
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
      this.proc.kill();
      this.proc = null;
    }
  }
}
