// One-time top-ups and Log in with PayPal against an in-process stand-in for PayPal's HTTP API.
// Response shapes follow the Orders v2, Payments v2 and Identity v1 schemas; the stand-in exists only in tests.
import { test, before } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  PUBLIC_BASE_URL: "http://localhost:8787",
  PAYPAL_CLIENT_ID: "test-client",
  PAYPAL_CLIENT_SECRET: "test-secret",
  PAYPAL_LOGIN_ENABLED: "true",
  POLICY_MAX_TOPUP: "500.00",
  POLICY_MAX_AGENT_TOPUP: "20.00",
  TITHE_AMOUNT: "10.00",
  TITHE_CURRENCY: "USD",
  TITHE_INTERVAL_UNIT: "MONTH",
  TITHE_PRODUCT_NAME: "Test tithe",
  BRAND_NAME: "Upstream",
  POLICY_MAX_PACKAGE_SHARE: "0.6",
  POLICY_MIN_PAYOUT: "1.00",
  POLICY_MAX_PAYOUT: "250.00",
  POLICY_PAYOUT_FEE_RESERVE: "0.02",
  POLICY_RESERVE_DAYS: "60",
  POLICY_CANCEL_UNCLAIMED_AFTER_DAYS: "7",
  MODEL_API_KEY: "",
  MODEL_API_BASE: "https://api.meta.ai",
  UPSTREAM_MODEL: "muse-spark-1.3",
  UPSTREAM_EFFORT: "medium",
  DEPSDEV_API_BASE: "https://api.deps.dev/v3",
  ECOSYSTEMS_API_BASE: "https://packages.ecosyste.ms/api/v1",
  METADATA_CACHE_HOURS: "24",
});

const { openDb, setDbForTests, db, now } = await import("../src/db.ts");
const { setPayPalFetch } = await import("../src/paypal/client.ts");
const { poolSummary } = await import("../src/ledger.ts");
const t = await import("../src/topups.ts");
const claims = await import("../src/claims.ts");
const { sessionCredits } = await import("../src/credits.ts");

type Ord = { id: string; status: string; custom_id: string; value: string; captures: any[]; refunds: any[] };
const orders = new Map<string, Ord>();
const captureRequestIds: string[] = [];
let userinfo: { status: number; body: unknown } = { status: 200, body: {} };
let openidPath404 = false;

const view = (o: Ord) => ({
  id: o.id,
  status: o.status,
  purchase_units: [{ reference_id: o.custom_id, custom_id: o.custom_id, payments: { captures: o.captures, refunds: o.refunds } }],
  links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` }],
});

function fakePayPal(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/oauth2/token") {
      const body = String(init?.body ?? "");
      if (body.startsWith("grant_type=authorization_code")) return json(200, { access_token: "user-token", token_type: "Bearer", expires_in: 28800 });
      return json(200, { access_token: "app-token", expires_in: 3600 });
    }
    if (url.pathname === "/v1/identity/openidconnect/userinfo") return openidPath404 ? json(404, { name: "RESOURCE_NOT_FOUND" }) : json(userinfo.status, userinfo.body);
    if (url.pathname === "/v1/identity/oauth2/userinfo") return json(userinfo.status, userinfo.body);
    if (url.pathname === "/v2/checkout/orders" && init?.method === "POST") {
      const b = JSON.parse(String(init.body));
      assert.equal(b.intent, "CAPTURE");
      assert.equal(b.payment_source.paypal.experience_context.shipping_preference, "NO_SHIPPING");
      const o: Ord = { id: `ORD${orders.size + 1}`, status: "PAYER_ACTION_REQUIRED", custom_id: b.purchase_units[0].custom_id, value: b.purchase_units[0].amount.value, captures: [], refunds: [] };
      orders.set(o.id, o);
      return json(200, view(o));
    }
    const cap = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (cap) {
      captureRequestIds.push(new Headers(init?.headers).get("PayPal-Request-Id") ?? "");
      const o = orders.get(cap[1])!;
      if (o.status !== "APPROVED") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: o.status === "COMPLETED" ? "ORDER_ALREADY_CAPTURED" : "ORDER_NOT_APPROVED" }] });
      o.status = "COMPLETED";
      o.captures = [{
        id: `CAP-${o.id}`, status: "COMPLETED", custom_id: o.custom_id, amount: { currency_code: "USD", value: o.value },
        seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: o.value }, paypal_fee: { currency_code: "USD", value: "0.87" }, net_amount: { currency_code: "USD", value: (Number(o.value) - 0.87).toFixed(2) } },
      }];
      return json(201, view(o));
    }
    const get = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (get) return json(200, view(orders.get(get[1])!));
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  }) as typeof fetch;
}

before(() => {
  setDbForTests(openDb(":memory:"));
  setPayPalFetch(fakePayPal());
});

test("top-up: approval link, capture books PayPal's gross and fee, retries and refunds book once", async () => {
  const top = await t.startTopup({ userId: "local", amount: "25", source: "dashboard" });
  assert.match(top.approve_url!, /checkoutnow\?token=ORD1/);
  assert.equal(top.amount_minor, 2500);

  // The payer comes back before approving: nothing is booked and the order stays open.
  let r = await t.captureTopup(top.id);
  assert.equal(r.capture_id, null);
  assert.equal(poolSummary("USD", "local").fundingGross, 0);

  orders.get("ORD1")!.status = "APPROVED";
  r = await t.captureTopup(top.id);
  assert.equal(r.capture_status, "COMPLETED");
  const p = poolSummary("USD", "local");
  assert.equal(p.fundingGross, 2500);
  assert.equal(p.fundingFees, -87);

  // Returning twice (or a webhook after the redirect) re-reads the order; no second capture, no double booking.
  await t.captureTopup(top.id);
  await t.syncTopup(top.id);
  assert.deepEqual(captureRequestIds, [`${top.id}-capture`, `${top.id}-capture`], "both capture attempts used the same PayPal-Request-Id");
  assert.equal(poolSummary("USD", "local").fundingGross, 2500);

  // A refund PayPal reports on the order comes out of the pool, minus the fee PayPal hands back.
  const o = orders.get("ORD1")!;
  o.captures[0].status = "PARTIALLY_REFUNDED";
  o.refunds = [{ id: "REF1", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" }, seller_payable_breakdown: { gross_amount: { currency_code: "USD", value: "10.00" }, paypal_fee: { currency_code: "USD", value: "0.30" }, net_amount: { currency_code: "USD", value: "9.70" } } }];
  await t.syncTopup(top.id);
  await t.syncTopup(top.id);
  const after = poolSummary("USD", "local");
  assert.equal(after.fundingGross, 1500);
  assert.equal(after.fundingFees, -57);
});

test("top-up limits: dashboard cap, and agents are capped per 24 hours with every request counted", async () => {
  await assert.rejects(t.startTopup({ userId: "local", amount: "500.01", source: "dashboard" }), /largest one-time top-up/);
  await assert.rejects(t.startTopup({ userId: "local", amount: "0", source: "dashboard" }), /more than zero/);
  await assert.rejects(t.startTopup({ userId: "local", amount: "1.234", source: "dashboard" }), /precision/);
  await t.startTopup({ userId: "local", amount: "15", source: "agent", note: "pool ran out" });
  assert.equal(t.agentAllowance("local")!.left_minor, 500);
  await assert.rejects(t.startTopup({ userId: "local", amount: "5.01", source: "agent" }), /more than an agent may request/);
  await t.startTopup({ userId: "local", amount: "5", source: "agent" });
  assert.equal(t.agentAllowance("local")!.left_minor, 0);
});

test("CHECKOUT.ORDER.APPROVED captures a top-up whose payer closed the tab", async () => {
  const top = await t.startTopup({ userId: "local", amount: "12.00", source: "dashboard" });
  const o = [...orders.values()].find((x) => x.custom_id === top.id)!;
  o.status = "APPROVED";
  const id = await t.topupFromWebhook("CHECKOUT.ORDER.APPROVED", { id: o.id, status: "APPROVED" });
  assert.equal(id, top.id);
  assert.equal((db().prepare("SELECT capture_status FROM topups WHERE id = ?").get(top.id) as any).capture_status, "COMPLETED");
  assert.equal(await t.topupFromWebhook("PAYMENT.CAPTURE.COMPLETED", { id: "SOMEONE-ELSES-CAPTURE" }), null, "unrelated captures are ignored");
});

test("Log in with PayPal fills a GitHub claim with the PayPal-verified email, once", async () => {
  db().prepare("INSERT INTO claims(id, repo, method, github_login, token, status, created_at) VALUES ('c1','github.com/a/b','github_admin','alice','tok-1','pending',?)").run(now());
  const url = new URL(claims.paypalLoginStart({ token: "tok-1" }));
  assert.equal(url.origin + url.pathname, "https://www.sandbox.paypal.com/connect");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8787/api/claims/paypal/callback");
  const state = url.searchParams.get("state")!;

  openidPath404 = true; // the integration guide's userinfo path is tried when the reference path is missing
  userinfo = { status: 200, body: { user_id: "https://www.paypal.com/webapps/auth/identity/user/x", email: "alice@paypal.example", email_verified: true, verified_account: true } };
  const r = await claims.paypalLoginCallback("auth-code", state);
  assert.equal(r.mode, "github_claim");
  assert.equal(claims.payableClaim("github.com/a/b")?.paypal_receiver, "alice@paypal.example");
  assert.equal((claims.payableClaim("github.com/a/b")?.evidence as any).paypal_identity.verified_account, true);
  await assert.rejects(claims.paypalLoginCallback("auth-code", state), /already used/);
});

test("Log in with PayPal refuses an unverified email and can start a FUNDING.yml claim", async () => {
  openidPath404 = false;
  userinfo = { status: 200, body: { email: "bob@paypal.example", email_verified: false } };
  const s1 = new URL(claims.paypalLoginStart({ repo: "bob/lib" })).searchParams.get("state")!;
  await assert.rejects(claims.paypalLoginCallback("c", s1), /isn't verified/);

  userinfo = { status: 200, body: { email: "bob@paypal.example", email_verified: true } };
  const s2 = new URL(claims.paypalLoginStart({ repo: "bob/lib" })).searchParams.get("state")!;
  const r = await claims.paypalLoginCallback("c", s2);
  assert.equal(r.mode, "funding_claim");
  const v = claims.fundingClaimView(r.claim.id)!;
  assert.equal(v.receiver, "b•••@paypal.example");
  assert.equal(v.receiver_verified_by_paypal, true);
  assert.match(v.instruction, /^custom: \["http:\/\/localhost:8787\/c\/upc_/);
});

test("PR credits come from the active validated run and escape table pipes", () => {
  db().prepare("INSERT INTO sessions(id, started_at, last_event_at, status) VALUES ('s1',?,?,'attributed')").run(now(), now());
  const validated = {
    weights: [
      { ecosystem: "npm", name: "zod", weight: 0.75, classification: "meaningful", evidence_ids: ["ev_1_0"], rationale: "Schemas | everywhere", proposed_weight: 3 },
      { ecosystem: "npm", name: "react", weight: 0, classification: "not_used", evidence_ids: [], rationale: "", proposed_weight: 0 },
    ],
    unallocated: 0.25,
    flags: [],
  };
  const cands = { candidates: [{ ecosystem: "npm", name: "zod", repo: "github.com/colinhacks/zod" }], evidence: [] };
  db().prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('r1','s1',?,'llm',?,?,'[]',1)").run(now(), JSON.stringify(cands), JSON.stringify(validated));
  const c = sessionCredits("s1")!;
  assert.equal(c.packages, 1);
  assert.match(c.markdown, /\| \[zod\]\(https:\/\/github\.com\/colinhacks\/zod\) \| meaningful \| 75% \| Schemas \\\| everywhere \|/);
  assert.match(c.markdown, /25% of the session's share went to no package/);
  assert.doesNotMatch(c.markdown, /react/);
  assert.equal(sessionCredits("nope"), undefined);
});
