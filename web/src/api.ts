import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "upstream.adminToken";

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setAdminToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the token then lasts for this page only.
  }
  window.dispatchEvent(new Event("upstream:token"));
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

// Signed in with GitHub: the session cookie authorises requests, so no token is needed.
let signedIn = false;
export function setSignedIn(on: boolean) {
  signedIn = on;
}

let needToken: (() => Promise<string | null>) | null = null;
export function registerTokenPrompt(fn: () => Promise<string | null>) {
  needToken = fn;
}

/** Gzips a request body in the browser, or returns null where CompressionStream isn't available. */
async function gzip(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") return null;
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

/**
 * `compress` gzips the body, for session uploads. They're smaller that way, and the host's edge firewall reads plain
 * text bodies: a session full of shell commands and code can look like an attack to it and be refused before it
 * reaches Upstream, which checks everything it receives itself. Express inflates the body before any limit applies.
 */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; admin?: boolean; compress?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  // Reads send the token too when this browser holds one: a private dashboard needs it to read anything.
  let t = getAdminToken();
  if (init.admin && !t && !signedIn && needToken) t = await needToken();
  if (init.admin && !t && !signedIn) throw new ApiError(401, { error: "Please sign in first." });
  if (t) headers["x-admin-token"] = t;
  let payload: BodyInit | undefined = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  if (init.compress && typeof payload === "string") {
    const zipped = await gzip(payload);
    if (zipped) {
      payload = zipped;
      headers["Content-Encoding"] = "gzip";
    }
  }
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: payload,
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // A proxy or host error page instead of the API's JSON: report the HTTP status, not a parse error.
    body = { error: `The server answered HTTP ${res.status} with a non-JSON response.` };
  }
  // A rejected token is forgotten, which also brings back the unlock screen on a private dashboard.
  if (res.status === 401 && t) setAdminToken(null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/**
 * Fetch JSON for a page. `poll` (ms) refreshes silently while the tab is visible, so new
 * hook events and PayPal updates appear without a reload.
 */
export function useApi<T = any>(path: string | null, deps: unknown[] = [], opts: { poll?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const load = useCallback(async (silent = false) => {
    if (!path) return;
    if (!silent) setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!silent) setError((e as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!opts.poll || !path) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, opts.poll);
    return () => clearInterval(t);
  }, [load, opts.poll, path]);
  return { data, error, loading, reload: () => load(), refresh: () => load(true), setData, updatedAt };
}
