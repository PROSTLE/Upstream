import { AsyncLocalStorage } from "node:async_hooks";
import { config, features } from "../config.ts";
import { db, LOCAL_USER, now } from "../db.ts";

// Whose work a PayPal call is, so each person's call log shows only their own. Background jobs set it per record.
const actor = new AsyncLocalStorage<string>();
export const runAsUser = <T>(userId: string, fn: () => T): T => actor.run(userId, fn);

export class PayPalError extends Error {
  status: number;
  body: unknown;
  debugId?: string;
  errorName?: string;
  constructor(status: number, body: unknown, debugId?: string) {
    const b = body as { name?: string; message?: string; error_description?: string } | undefined;
    super(`PayPal ${status}: ${b?.name ?? ""} ${b?.message ?? b?.error_description ?? ""}`.trim());
    this.status = status;
    this.body = body;
    this.debugId = debugId;
    this.errorName = b?.name;
  }
}

export class PayPalNotConfigured extends Error {
  constructor() {
    super("PayPal is not configured: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  }
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = fetch;
/** Tests inject a transport here; production always uses the global fetch. */
export function setPayPalFetch(f: FetchLike): void {
  fetchImpl = f;
  cachedToken = undefined;
}
/** The transport in use, for calls that don't take the app's bearer token (Log in with PayPal's code exchange). */
export const paypalFetch = (): FetchLike => fetchImpl;

let cachedToken: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (!features.paypal) throw new PayPalNotConfigured();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const basic = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetchImpl(`${config.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) {
    throw new PayPalError(res.status, body, res.headers.get("paypal-debug-id") ?? undefined);
  }
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 0) * 1000 };
  return cachedToken.token;
}

export interface PayPalResponse<T> {
  status: number;
  data: T;
  debugId?: string;
}

export async function paypal<T = unknown>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  opts: { body?: unknown; rawBody?: string; requestId?: string; query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<PayPalResponse<T>> {
  const token = await accessToken();
  const url = new URL(config.PAYPAL_API_BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined || opts.rawBody !== undefined) headers["Content-Type"] = "application/json";
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
  Object.assign(headers, opts.headers);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch (e) {
    logCall(method, path, opts.requestId, null, undefined, Date.now() - started, "NETWORK_ERROR");
    throw e;
  }
  const debugId = res.headers.get("paypal-debug-id") ?? undefined;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  const errName = res.ok ? undefined : (data as { name?: string })?.name;
  logCall(method, path, opts.requestId, res.status, debugId, Date.now() - started, errName);
  if (!res.ok) throw new PayPalError(res.status, data, debugId);
  return { status: res.status, data, debugId };
}

export function logCall(
  method: string,
  path: string,
  requestId: string | undefined,
  status: number | null,
  debugId: string | undefined,
  ms: number,
  errorName: string | undefined,
) {
  try {
    db()
      .prepare(
        "INSERT INTO paypal_calls(at, method, path, request_id, status, debug_id, duration_ms, error_name, user_id) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(now(), method, path, requestId ?? null, status, debugId ?? null, ms, errorName ?? null, actor.getStore() ?? LOCAL_USER);
  } catch {
    // Audit logging must never break a payment call.
  }
}

/** Follow PayPal HATEOAS links by rel. */
export function link(obj: { links?: { rel: string; href: string }[] } | undefined, rel: string) {
  return obj?.links?.find((l) => l.rel === rel)?.href;
}
