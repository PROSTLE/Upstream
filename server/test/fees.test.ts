// Payouts wait until PayPal's fee is a small share of them. The default estimate is $0.25 and the limit 5%, so $5.00.
import "./helpers/env.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { openDb, setDbForTests, db, now } = await import("../src/db.ts");
const { setPayPalFetch } = await import("../src/paypal/client.ts");
const { book } = await import("../src/ledger.ts");
const s = await import("../src/settlement.ts");
const { config } = await import("../src/config.ts");

function fakePayPal(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return json(201, { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING", sender_batch_header: body.sender_batch_header } });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  }) as typeof fetch;
}

/** A funded pool and one reviewed session: zod has a verified maintainer and gets a share of `zodWeight`; the rest goes to dayjs, unclaimed. */
function seed(fundedMinor: number, zodWeight: number) {
  book({ dedupeKey: `fund:${fundedMinor}`, kind: "FUNDING_GROSS", amountMinor: fundedMinor, currency: "USD", refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" });
  const d = db();
  d.prepare("INSERT INTO sessions(id, started_at, last_event_at, status) VALUES ('s1', ?, ?, 'attributed')").run(now(), now());
  d.prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod'), ('npm','dayjs','github.com/iamkun/dayjs')").run();
  d.prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, created_at, verified_at) VALUES ('clm1','github.com/colinhacks/zod','github_admin','m@example.com','verified',?,?)").run(now(), now());
  const validated = {
    weights: [
      { ecosystem: "npm", name: "zod", weight: zodWeight, classification: "meaningful", evidence_ids: ["e1"], rationale: "", proposed_weight: 3 },
      { ecosystem: "npm", name: "dayjs", weight: 1 - zodWeight, classification: "supporting", evidence_ids: ["e2"], rationale: "", proposed_weight: 1 },
    ],
    unallocated: 0,
    flags: [],
  };
  d.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('r1','s1',?,'llm','{}',?,'[]',1)").run(now(), JSON.stringify(validated));
}

const plan = () => {
  const { settlementId } = s.planSettlement("local");
  const row = db().prepare("SELECT * FROM settlements WHERE id = ?").get(settlementId) as any;
  return { id: settlementId, row, policy: JSON.parse(row.policy_json) };
};

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  setPayPalFetch(fakePayPal());
});

test("the threshold is the fee over the allowed share, inside the min and max", () => {
  assert.deepEqual(s.feeEstimate("USD"), { minor: 25, source: "default" });
  assert.equal(s.payoutThreshold("USD"), 500);
  assert.equal(s.payoutThreshold("USD", 7), 140);
  assert.equal(s.payoutThreshold("USD", 1), 100, "never below POLICY_MIN_PAYOUT");
  assert.equal(s.payoutThreshold("USD", 5_000), 25_000, "never above POLICY_MAX_PAYOUT");
  // 0.25 / 0.05 and 0.07 / 0.05 are not exact in floating point, and must not round up a cent.
  assert.equal(s.payoutThreshold("USD", 21), 420);
});

test("below the threshold a verified maintainer's share is held, with the numbers to explain why", () => {
  // Distributable floor(1000 / 1.05) = 952; zod's 30% rounds to 286, under $5.00.
  seed(1000, 0.3);
  const { row, policy } = plan();
  assert.equal(row.planned_minor, 0, "nothing goes to PayPal");
  assert.equal(row.fee_reserve_minor, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM payout_items").get() as { n: number }).n, 0);
  assert.equal((db().prepare("SELECT target FROM allocations WHERE package = 'zod'").get() as { target: string }).target, "reserve");
  assert.deepEqual(policy.held_for_fees, [{ repo: "github.com/colinhacks/zod", held_minor: 286, threshold_minor: 500, fee_estimate_minor: 25, fee_share_if_paid_now: 25 / 286, estimate_source: "default" }]);
});

test("at the threshold it is paid, and the reserve covers the fee", () => {
  // floor(10500 / 1.05) = 10000, and a 5% share is exactly $5.00.
  seed(10_500, 0.05);
  const { row, policy, id } = plan();
  assert.equal(row.planned_minor, 500);
  assert.deepEqual(policy.held_for_fees, []);
  assert.equal(row.fee_reserve_minor, 25, "max(ceil(2% of 500) = 10, 25)");
  const check = policy.checks.find((c: any) => c.id === "item_min");
  assert.equal(check.label, "Each item ≥ $5.00, so PayPal's fee stays ≤ 5%");
  assert.equal(check.ok, true);
  assert.match(check.detail, /\$0\.25 \(the default, until PayPal reports one\)/);
  assert.equal(policy.params.payout_threshold, "5.00");
  // Everything is allocated and the reserve still fits, so approval goes through.
  assert.equal(policy.checks.find((c: any) => c.id === "budget").ok, true);
  s.approveSettlement(id);
});

test("on a large item the percentage reserve is the bigger one", () => {
  seed(100_000, 0.4);
  const { row } = plan();
  // floor(100000 / 1.05) = 95238; 40% = 38095; ceil(2%) = 762, which is more than the $0.25 fee.
  assert.equal(row.planned_minor, 25_000, "the per-item cap");
  assert.equal(row.fee_reserve_minor, 500, "ceil(2% of 25000)");
});

test("once PayPal reports a fee, that fee sets the threshold", async () => {
  seed(10_500, 0.05);
  const { id } = plan();
  s.approveSettlement(id);
  await s.executeSettlement(id);
  const item = db().prepare("SELECT * FROM payout_items").get() as any;
  s.applyPayoutItem({ payout_item_id: "PI1", transaction_id: "T1", transaction_status: "SUCCESS", payout_item_fee: { currency: "USD", value: "0.35" }, payout_item: { sender_item_id: item.sender_item_id } } as any, "api_sync");
  assert.deepEqual(s.feeEstimate("USD"), { minor: 35, source: "paypal" });
  assert.equal(s.payoutThreshold("USD"), 700);
  assert.equal(s.feeEstimate("EUR").source, "default", "per currency");
  assert.equal(config.POLICY_MAX_FEE_SHARE, 0.05);

  // The next plan uses it: this share would have cleared the old $5.00 but not $7.00.
  db().prepare("UPDATE sessions SET allocated_settlement_id = NULL").run();
  book({ dedupeKey: "fund:more", kind: "FUNDING_GROSS", amountMinor: 2000, currency: "USD", refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" });
  const next = plan();
  const held = next.policy.held_for_fees[0];
  assert.equal(held.threshold_minor, 700);
  assert.equal(held.fee_estimate_minor, 35);
  assert.equal(held.estimate_source, "paypal");
  assert.match(next.policy.checks.find((c: any) => c.id === "item_min").label, /≥ \$7\.00/);
});

test("the audit reads the threshold in force when a run was planned", async () => {
  const { auditReport } = await import("../src/audit.ts");
  seed(10_500, 0.05);
  const { id } = plan();
  s.approveSettlement(id);
  await s.executeSettlement(id);
  assert.equal(auditReport("local").checks.find((c) => c.id === "payout_caps_respected")!.status, "pass");
  db().prepare("UPDATE payout_items SET amount_minor = 400").run();
  assert.equal(auditReport("local").checks.find((c) => c.id === "payout_caps_respected")!.status, "fail");
});
