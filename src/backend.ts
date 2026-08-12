import * as http from "http";
import * as https from "https";
import { URL } from "url";

/** Ollama's cross-platform download page. */
export const OLLAMA_DOWNLOAD = "https://ollama.com/download";

interface GetResult {
  status: number;
  body: string;
}

/**
 * GET a URL (http or https). Resolves with {status, body}; rejects ONLY on a
 * network error / timeout — a non-2xx still resolves so callers can distinguish
 * "server said no" (e.g. 401) from "couldn't reach it".
 */
function httpGet(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 4000
): Promise<GetResult> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e as Error);
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port,
        path: (u.pathname || "/") + (u.search || ""),
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** Strip a trailing `/v1` (and slashes) so we can hit Ollama's native `/api/tags`. */
function ollamaHostBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * The installed Ollama model names, or `null` if Ollama isn't reachable at all
 * (not installed / not running). An empty array means Ollama is up but has no
 * models pulled.
 */
export async function ollamaModels(baseUrl: string): Promise<string[] | null> {
  try {
    const { status, body } = await httpGet(ollamaHostBase(baseUrl) + "/api/tags");
    if (status !== 200) {
      return null;
    }
    const data = JSON.parse(body) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
  } catch {
    return null;
  }
}

/** True if `want` (e.g. "paritok-4b-v1") is among `models`, ignoring the `:tag`. */
export function modelPresent(models: string[], want: string): boolean {
  const w = want.toLowerCase();
  return models.some((m) => {
    const n = m.toLowerCase();
    return n === w || n === `${w}:latest` || n.startsWith(`${w}:`);
  });
}

/**
 * Validate a Paritok GPU-server API key via `GET {base}/test`:
 *   true  = accepted (HTTP 200)
 *   false = rejected (HTTP 401/403 — invalid/expired key)
 *   null  = couldn't determine (network error, or any other status) → don't block
 */
export async function gpuKeyState(baseUrl: string, key: string): Promise<boolean | null> {
  try {
    const { status } = await httpGet(baseUrl.replace(/\/+$/, "") + "/test", {
      Authorization: `Bearer ${key}`,
    });
    if (status === 200) {
      return true;
    }
    if (status === 401 || status === 403) {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}
