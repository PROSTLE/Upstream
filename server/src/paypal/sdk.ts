// PayPal's official Server SDK (@paypal/paypal-server-sdk), which APIMatic generates from PayPal's API definitions.
// Orders v2 and Subscriptions go through it: the SDK builds each request from its typed models, sets the headers
// (PayPal-Request-Id, Prefer) and turns error replies into typed errors.
//
// The SDK's HTTP layer is axios, and axios accepts an adapter, so every SDK request travels over Upstream's own
// transport. That keeps one access token for both kinds of call, honours PAYPAL_API_BASE, lets tests stand in for
// PayPal, and puts each call in the PayPal call log marked "sdk".
//
// Money is booked from PayPal's JSON reply itself, the same shape webhooks deliver, so one code path books both.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  ApiError,
  Client,
  Environment,
  OrdersController,
  ResponseValidationError,
  SubscriptionsController,
  type ApiResponse,
} from "@paypal/paypal-server-sdk";
import { config, features } from "../config.ts";
import { accessToken, logCall, paypalFetch, PayPalError, PayPalNotConfigured, transportVersion, type PayPalResponse } from "./client.ts";

const PACKAGE = "@paypal/paypal-server-sdk";

/** The installed SDK version, read from its package.json (the package doesn't export that file). */
export const SDK_VERSION: string = (() => {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve(PACKAGE));
    for (let i = 0; i < 4; i++) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
        if (pkg.name === PACKAGE && pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Reported as unknown below.
  }
  return "unknown";
})();

export const SDK_PACKAGE = PACKAGE;

type AxiosLikeConfig = { url?: string; method?: string; headers?: unknown; data?: unknown };

function plainHeaders(h: unknown): Record<string, string> {
  const raw = h && typeof (h as { toJSON?: unknown }).toJSON === "function" ? (h as { toJSON: () => Record<string, unknown> }).toJSON() : (h as Record<string, unknown>) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === false) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** An axios adapter: sends what the SDK built over Upstream's transport and hands PayPal's raw reply back to it. */
async function viaUpstreamTransport(cfg: AxiosLikeConfig) {
  const original = new URL(String(cfg.url));
  const target = `${config.PAYPAL_API_BASE}${original.pathname}${original.search}`;
  const method = String(cfg.method ?? "get").toUpperCase();
  const headers = plainHeaders(cfg.headers);
  const requestId = Object.entries(headers).find(([k]) => k.toLowerCase() === "paypal-request-id")?.[1];
  const body = typeof cfg.data === "string" ? cfg.data : cfg.data === undefined || cfg.data === null ? undefined : JSON.stringify(cfg.data);
  const started = Date.now();
  let res: Response;
  try {
    res = await paypalFetch()(target, { method, headers, body });
  } catch (e) {
    logCall(method, original.pathname, requestId, null, undefined, Date.now() - started, "NETWORK_ERROR", "sdk");
    throw e;
  }
  const text = await res.text();
  const debugId = res.headers.get("paypal-debug-id") ?? undefined;
  let errorName: string | undefined;
  if (!res.ok) {
    try {
      errorName = (JSON.parse(text) as { name?: string })?.name;
    } catch {
      errorName = undefined;
    }
  }
  logCall(method, original.pathname, requestId, res.status, debugId, Date.now() - started, errorName, "sdk");
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (responseHeaders[k] = v));
  return { data: text, status: res.status, statusText: res.statusText, headers: responseHeaders, config: cfg, request: {} };
}

interface Sdk {
  orders: OrdersController;
  subscriptions: SubscriptionsController;
}

let built: (Sdk & { transport: number }) | undefined;

function sdk(): Sdk {
  if (!features.paypal) throw new PayPalNotConfigured();
  if (built && built.transport === transportVersion()) return built;
  const client = new Client({
    environment: config.PAYPAL_ENV === "live" ? Environment.Production : Environment.Sandbox,
    timeout: 30_000,
    clientCredentialsAuthCredentials: {
      oAuthClientId: config.PAYPAL_CLIENT_ID!,
      oAuthClientSecret: config.PAYPAL_CLIENT_SECRET!,
      // The SDK asks for a token before each call once this one lapses; Upstream's own cache answers, so both share one token.
      oAuthTokenProvider: async () => ({ accessToken: await accessToken(), tokenType: "Bearer", expiry: BigInt(Math.floor(Date.now() / 1000) + 60) }),
    },
    unstable_httpClientOptions: { adapter: viaUpstreamTransport },
  });
  built = { orders: new OrdersController(client), subscriptions: new SubscriptionsController(client), transport: transportVersion() };
  return built;
}

const parse = (body: unknown): unknown => {
  if (typeof body !== "string" || !body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return { message: body.slice(0, 300) };
  }
};

/**
 * Runs one SDK call and returns PayPal's reply as the rest of the code expects it: status, the JSON PayPal sent, and its
 * debug id. A PayPal error becomes the same PayPalError a direct call throws. If PayPal answered 2xx with JSON the SDK's
 * schema doesn't expect, the reply is still used, because PayPal has already acted on it.
 */
export async function viaSdk<T>(call: (s: Sdk) => Promise<ApiResponse<unknown>>): Promise<PayPalResponse<T>> {
  try {
    const res = await call(sdk());
    return { status: res.statusCode, data: parse(res.body) as T, debugId: res.headers?.["paypal-debug-id"] };
  } catch (e) {
    if (e instanceof ResponseValidationError && e.statusCode >= 200 && e.statusCode < 300) {
      return { status: e.statusCode, data: parse(e.body) as T, debugId: e.headers?.["paypal-debug-id"] };
    }
    if (e instanceof ApiError) throw new PayPalError(e.statusCode, parse(e.body), e.headers?.["paypal-debug-id"]);
    throw e;
  }
}
