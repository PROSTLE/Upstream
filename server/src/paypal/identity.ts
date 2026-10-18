// Log in with PayPal (developer.paypal.com/docs/log-in-with-paypal/integrate/ and the Identity v1 API reference).
// Used only so a maintainer's payout email is one PayPal itself has verified, instead of one typed by hand.
import { config } from "../config.ts";
import { logCall, PayPalError, paypalFetch } from "./client.ts";

export const paypalRedirectUri = () => `${config.PUBLIC_BASE_URL}/api/claims/paypal/callback`;

export function paypalAuthorizeUrl(state: string): string {
  const u = new URL(`${config.PAYPAL_WEB_BASE}/connect`);
  u.searchParams.set("flowEntry", "static");
  u.searchParams.set("client_id", config.PAYPAL_CLIENT_ID!);
  u.searchParams.set("response_type", "code");
  // Email is the only attribute we use; the app's "user information" settings must include it.
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("redirect_uri", paypalRedirectUri());
  u.searchParams.set("state", state);
  return u.toString();
}

async function timed(method: string, path: string, init: RequestInit) {
  const started = Date.now();
  const res = await paypalFetch()(`${config.PAYPAL_API_BASE}${path}`, init);
  const debugId = res.headers.get("paypal-debug-id") ?? undefined;
  const body = (await res.json().catch(() => ({}))) as any;
  logCall(method, path, undefined, res.status, debugId, Date.now() - started, res.ok ? undefined : body?.name ?? body?.error);
  return { res, body, debugId };
}

export interface PayPalIdentity {
  email: string;
  email_verified: boolean | null;
  verified_account: boolean | null;
  user_id: string | null;
}

/** Exchange the authorization code, then read the user's profile. The user's access token is not stored. */
export async function paypalIdentity(code: string): Promise<PayPalIdentity> {
  const basic = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const tok = await timed("POST", "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  if (!tok.res.ok || !tok.body.access_token) throw new PayPalError(tok.res.status, tok.body, tok.debugId);
  const headers = { Authorization: `Bearer ${tok.body.access_token}`, Accept: "application/json" };
  // The API reference documents /openidconnect/userinfo; the integration guide shows /oauth2/userinfo. Try both.
  let info = await timed("GET", "/v1/identity/openidconnect/userinfo", { headers });
  if (info.res.status === 404) info = await timed("GET", "/v1/identity/oauth2/userinfo", { headers });
  if (!info.res.ok) throw new PayPalError(info.res.status, info.body, info.debugId);
  const b = info.body;
  const email = typeof b.email === "string" ? b.email : undefined;
  if (!email) throw new Error("PayPal didn't share an email address. Ask the server owner to enable Email under the app's Log in with PayPal settings.");
  return {
    email,
    email_verified: typeof b.email_verified === "boolean" ? b.email_verified : null,
    verified_account: typeof b.verified_account === "boolean" ? b.verified_account : null,
    user_id: typeof b.user_id === "string" ? b.user_id : null,
  };
}
