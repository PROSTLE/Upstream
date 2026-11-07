// End-to-end settlement against an in-process stand-in for PayPal's HTTP API.
// The stand-in only exists in tests; the product code always talks to PayPal.
import { test, before } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  PUBLIC_BASE_URL: "http://localhost:8787",
  PAYPAL_CLIENT_ID: "test-client",
  PAYPAL_CLIENT_SECRET: "test-secret",
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
const { book, poolSummary } = await import("../src/ledger.ts");
const s = await import("../src/settlement.ts");

const posts: { batchId: string; requestId: string | null }[] = [];
const seenBatchIds = new Map<string, string>();
const items = new Map<string, any>();

function fakePayPal(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "paypal-debug-id": "dbg123" } });
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const id = body.sender_batch_header.sender_batch_id;
      posts.push({ batchId: id, requestId: new Headers(init.headers).get("PayPal-Request-Id") });
      if (seenBatchIds.has(id)) {
        return json(400, { name: "DUPLICATE_SENDER_BATCH_ID_TEST", message: `Batch with given sender_batch_id ${id} already exists` });
      }
      const pid = `PB${seenBatchIds.size + 1}`;
      seenBatchIds.set(id, pid);
      body.items.forEach((it: any, i: number) =>
        items.set(it.sender_item_id, { payout_item_id: `PI${i + 1}`, payout_batch_id: pid, transaction_status: "PENDING", payout_item: { ...it } }),
      );
      return json(201, { batch_header: { payout_batch_id: pid, batch_status: "PENDING", sender_batch_header: { sender_batch_id: id } } });
    }
    const cancel = url.pathname.match(/^\/v1\/payments\/payouts-item\/([^/]+)\/cancel$/);
    if (cancel) {
      const it = [...items.values()].find((x) => x.payout_item_id === cancel[1]);
      it.transaction_status = "RETURNED";
      return json(200, it);
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  }) as typeof fetch;
}

before(() => {
  setDbForTests(openDb(":memory:"));
  setPayPalFetch(fakePayPal());
  // Funds in, as PayPal's subscription transaction sync would book them.
  book({ dedupeKey: "fund:T1", kind: "FUNDING_GROSS", amountMinor: 1000, currency: "USD", source: "api_sync", userId: "local" });
  book({ dedupeKey: "fundfee:T1", kind: "FUNDING_FEE", amountMinor: -79, currency: "USD", source: "api_sync", userId: "local" });
  const d = db();
  d.prepare("INSERT INTO sessions(id, started_at, last_event_at, status) VALUES ('sess1', ?, ?, 'attributed')").run(now(), now());
  d.prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod'), ('npm','dayjs','github.com/iamkun/dayjs')").run();
  d.prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, created_at, verified_at) VALUES ('clm1','github.com/colinhacks/zod','github_admin','maint@example.com','verified',?,?)").run(now(), now());
  const validated = {
    weights: [
      { ecosystem: "npm", name: "zod", weight: 0.6, classification: "meaningful", evidence_ids: ["ev_1_0"], rationale: "", proposed_weight: 3 },
      { ecosystem: "npm", name: "dayjs", weight: 0.4, classification: "supporting", evidence_ids: ["ev_2_0"], rationale: "", proposed_weight: 2 },
    ],
    unallocated: 0,
    flags: [],
  };
  d.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('run1','sess1',?,'llm','{}',?, '[]', 1)").run(now(), JSON.stringify(validated));
});

test("plan -> approve -> execute twice sends exactly one PayPal batch", async () => {
  const { settlementId } = s.planSettlement("local");
  const st = db().prepare("SELECT * FROM settlements WHERE id = ?").get(settlementId) as any;
  // available 9.21, distributable floor(921/1.05) = 877 -> zod 526 (claimed), dayjs 351 (reserved)
  assert.equal(st.status, "draft");
  assert.equal(st.planned_minor, 526);
  assert.equal(st.reserved_minor, 351);
  s.approveSettlement(settlementId);
  const first = await s.executeSettlement(settlementId);
  const second = await s.executeSettlement(settlementId);
  assert.equal(first.alreadySent, false);
  assert.equal(second.alreadySent, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].requestId, `upstream-${settlementId}`);

  const replay = await s.replaySettlement(settlementId);
  assert.equal(replay.rejected, true);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[1].requestId, posts[0].requestId);
});

test("UNCLAIMED item books money out; cancelling returns it and re-earmarks for the repo", async () => {
  const item = db().prepare("SELECT * FROM payout_items").get() as any;
  const it = items.get(item.sender_item_id);
  it.transaction_status = "UNCLAIMED";
  it.payout_item_fee = { currency: "USD", value: "0.11" };
  s.applyPayoutItem(it, "webhook", "PAYMENT.PAYOUTS-ITEM.UNCLAIMED");
  let pool = poolSummary("USD", "local");
  assert.equal(pool.payoutsSent, -526);
  assert.equal(pool.payoutFees, -11);

  await s.cancelUnclaimed(item.sender_item_id, { manual: true });
  pool = poolSummary("USD", "local");
  assert.equal(pool.returned, 526);
  const alloc = db().prepare("SELECT status FROM allocations WHERE package = 'zod'").get() as any;
  assert.equal(alloc.status, "reserved");
  const claim = db().prepare("SELECT status FROM claims WHERE id = 'clm1'").get() as any;
  assert.equal(claim.status, "receiver_unclaimed");
  // Balance = 1000 - 79 - 526 - 11 + 526 = 910; zod (526) and dayjs (351) stay earmarked.
  assert.equal(pool.balance, 910);
  assert.equal(pool.reserved, 877);
  // The batch isn't final, so what's left of its $0.25 fee reserve after the reported $0.11 is still held: 14.
  assert.equal(pool.inFlight, 14);
  assert.equal(pool.available, 19);
});
