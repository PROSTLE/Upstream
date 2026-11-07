// Preflight: checks each configured credential and dependency with a live, read-only call.
// Writes nothing to PayPal, the database or the audit log, and sends no prompt to the model.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { modelClient } from "../attribution/llm.ts";
import { config, features, repoRoot } from "../config.ts";

type Status = "ok" | "warn" | "fail" | "skip";
const results: { status: Status; area: string; message: string }[] = [];
const report = (status: Status, area: string, message: string) => results.push({ status, area, message });

async function getJson(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", "User-Agent": "upstream-doctor", ...init.headers } });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { res, body };
}

function secrets() {
  for (const [name, value] of [["ADMIN_TOKEN", config.ADMIN_TOKEN], ["INGEST_TOKEN", config.INGEST_TOKEN]] as const) {
    if (!value) report("fail", name, "not set; generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    else if (value.length < 32) report("warn", name, `only ${value.length} characters; use at least 32 random characters`);
    else report("ok", name, "set");
  }
}

async function paypal() {
  if (!features.paypal) return report("skip", "PayPal", "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
  const basic = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const { res, body } = await getJson(`${config.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok || !body?.access_token) {
    return report("fail", "PayPal OAuth", `${res.status} ${body?.error ?? ""} ${body?.error_description ?? ""} (debug id ${res.headers.get("paypal-debug-id") ?? "n/a"}). Check the ${config.PAYPAL_ENV} credentials.`);
  }
  report("ok", "PayPal OAuth", `${config.PAYPAL_ENV} token issued for app ${body.app_id ?? "(no app_id in response)"}`);
  const scopes = String(body.scope ?? "").split(/\s+/).filter((s) => /payout|subscription|billing/i.test(s));
  report("ok", "PayPal scopes", scopes.length ? scopes.join(", ") : "none mentioning payouts or billing; if a call fails with NOT_AUTHORIZED, enable the feature for this app in the PayPal developer dashboard");
  if (/invoicing/i.test(String(body.scope ?? ""))) report("ok", "PayPal Invoicing", "this app can issue monthly statements");
  else report("warn", "PayPal Invoicing", "this app has no invoicing permission, so monthly statements will fail. Turn on Invoicing for the app in the PayPal Developer Dashboard (Apps & Credentials, your app, Features)");
  const plans = await getJson(`${config.PAYPAL_API_BASE}/v1/billing/plans`, { headers: { Authorization: `Bearer ${body.access_token}` } });
  if (plans.res.ok) report("ok", "PayPal Subscriptions", `plans readable (${(plans.body?.plans ?? []).length} on the first page)`);
  else report("fail", "PayPal Subscriptions", `GET /v1/billing/plans returned ${plans.res.status} ${plans.body?.name ?? ""} (debug id ${plans.res.headers.get("paypal-debug-id") ?? "n/a"})`);
}

async function publicUrl() {
  const base = config.PUBLIC_BASE_URL;
  if (!base.startsWith("https://")) {
    report("warn", "PUBLIC_BASE_URL", `${base} is not https: PayPal will not deliver webhooks and GitHub OAuth only works on this machine. The hourly reconciler still syncs payouts, subscription payments and top-ups.`);
  }
  try {
    const { res, body } = await getJson(`${base}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (res.ok && body?.ok) report("ok", "PUBLIC_BASE_URL", `${base}/api/health answers (server running, PayPal ${body.paypal_env})`);
    else report("warn", "PUBLIC_BASE_URL", `${base}/api/health returned ${res.status}; is something else listening there?`);
  } catch (e) {
    report("warn", "PUBLIC_BASE_URL", `${base} not reachable (${(e as Error).message}). Fine if the server isn't started yet; webhooks and OAuth callbacks need it reachable.`);
  }
}

async function museModel() {
  if (!features.llm) return report("skip", "Muse Spark", "MODEL_API_KEY not set; only the import-count baseline runs when you attribute a session");
  const client = modelClient();
  try {
    const model = await client.models.retrieve(config.UPSTREAM_MODEL);
    report("ok", "Muse Spark", `key accepted at ${config.MODEL_API_BASE}; model ${model.id ?? config.UPSTREAM_MODEL} available, effort ${config.UPSTREAM_EFFORT}`);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) report("fail", "Muse Spark", "MODEL_API_KEY was rejected");
    else if (e instanceof Anthropic.NotFoundError) report("fail", "Muse Spark", `UPSTREAM_MODEL "${config.UPSTREAM_MODEL}" was not found for this key`);
    else if (e instanceof Anthropic.APIError) report("fail", "Muse Spark", `API error ${e.status}: ${e.message}`);
    else report("fail", "Muse Spark", (e as Error).message);
  }
}

async function github() {
  const callback = `${config.PUBLIC_BASE_URL}/api/claims/github/callback`;
  if (features.githubOAuth) report("ok", "GitHub OAuth", `client id/secret set; the OAuth app's callback URL must be exactly ${callback}`);
  else report("skip", "GitHub OAuth", `not set; maintainers can still claim with a FUNDING.yml token. To enable, create an OAuth app with callback ${callback}`);
  const { res, body } = await getJson("https://api.github.com/rate_limit", {
    headers: config.GITHUB_TOKEN ? { Authorization: `Bearer ${config.GITHUB_TOKEN}` } : {},
  });
  if (!res.ok) return report(config.GITHUB_TOKEN ? "fail" : "warn", "GitHub API", `rate_limit returned ${res.status}${config.GITHUB_TOKEN ? "; GITHUB_TOKEN may be invalid" : ""}`);
  const core = body?.resources?.core;
  const left = `${core?.remaining}/${core?.limit} requests left this hour`;
  if (config.GITHUB_TOKEN) report("ok", "GitHub API", `token accepted; ${left}`);
  else report("warn", "GitHub API", `anonymous; ${left}. FUNDING.yml lookups share this limit, so set GITHUB_TOKEN (a fine-grained token with public read access is enough)`);
}

function options() {
  const back = `${config.PUBLIC_BASE_URL}/api/claims/paypal/callback`;
  if (features.paypalLogin) report("ok", "Log in with PayPal", `enabled; in the app's Log in with PayPal settings the Return URL must be exactly ${back}, with Email shared`);
  else report("skip", "Log in with PayPal", `off; maintainers type their payout email. To enable, turn it on for the PayPal app (Return URL ${back}) and set PAYPAL_LOGIN_ENABLED=true`);
  report(config.POLICY_MAX_TOPUP ? "ok" : "skip", "Top-up cap", config.POLICY_MAX_TOPUP ? `one-time top-ups up to ${config.POLICY_MAX_TOPUP} ${config.TITHE_CURRENCY}` : "POLICY_MAX_TOPUP not set; only PayPal's limits apply to dashboard top-ups");
  report(features.agentTopups ? "ok" : "skip", "Agent top-ups", features.agentTopups ? `agents may request up to ${config.POLICY_MAX_AGENT_TOPUP} ${config.TITHE_CURRENCY} per 24 hours, each approved in PayPal` : "off (POLICY_MAX_AGENT_TOPUP not set, or PayPal keys missing)");
}

async function metadata() {
  // Probe with a dependency of this server itself, read from its own manifest.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "server", "package.json"), "utf8"));
  const name = Object.keys(pkg.dependencies ?? {}).find((n) => !n.startsWith("@"));
  if (!name) return report("skip", "deps.dev", "no unscoped dependency in server/package.json to probe with");
  const dd = await getJson(`${config.DEPSDEV_API_BASE}/systems/npm/packages/${encodeURIComponent(name)}`);
  report(dd.res.ok ? "ok" : "fail", "deps.dev", dd.res.ok ? `resolves npm:${name}` : `npm:${name} returned ${dd.res.status}`);
  const es = await getJson(`${config.ECOSYSTEMS_API_BASE}/registries/npmjs.org/packages/${encodeURIComponent(name)}`);
  report(es.res.ok ? "ok" : "warn", "ecosyste.ms", es.res.ok ? `resolves npm:${name}` : `npm:${name} returned ${es.res.status}; repo links fall back to deps.dev`);
}

console.log(`Upstream doctor: ${config.PAYPAL_ENV} @ ${config.PAYPAL_API_BASE}, public URL ${config.PUBLIC_BASE_URL}\n`);
if (!fs.existsSync(path.join(repoRoot, ".env"))) report("warn", ".env", "no .env file; values come from the process environment only");
secrets();
for (const check of [paypal, museModel, github, options, metadata, publicUrl]) {
  try {
    await check();
  } catch (e) {
    report("fail", check.name, `check crashed: ${(e as Error).message}`);
  }
}
const icon: Record<Status, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };
for (const r of results) console.log(`[${icon[r.status]}] ${r.area.padEnd(21)} ${r.message}`);
const failed = results.filter((r) => r.status === "fail").length;
console.log(`\n${failed ? `${failed} check(s) failed.` : "No failures."} Skipped checks are features that stay disabled until configured.`);
process.exit(failed ? 1 : 0);
