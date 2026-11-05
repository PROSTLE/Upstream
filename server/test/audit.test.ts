// The live audit must pass on records produced by the real settlement code, and fail when any of them is altered.
// PayPal is replaced by an in-process stand-in that exists only in tests.
import "./helpers/env.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";

const { openDb, setDbForTests, db, now } = await import("../src/db.ts");
const { setPayPalFetch } = await import("../src/paypal/client.ts");
const { book } = await import("../src/ledger.ts");
const s = await import("../src/settlement.ts");
const { auditReport } = await import("../src/audit.ts");

const batches = new Map<string, any[]>();
function fakePayPal(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const id = `PB${batches.size + 1}`;
      batches.set(id, body.items.map((it: any, i: number) => ({
        payout_item_id: `PI${i + 1}`, transaction_id: `TX${i + 1}`, transaction_status: "SUCCESS", payout_batch_id: id,
        payout_item_fee: { currency: "USD", value: "0.10" }, payout_item: { ...it },
      })));
      return json(201, { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } });
    }
    const get = url.pathname.match(/^\/v1\/payments\/payouts\/([^/]+)$/);
    if (get && batches.has(get[1])) {
      return json(200, { batch_header: { payout_batch_id: get[1], batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: "x" } }, items: batches.get(get[1]), total_pages: 1 });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  }) as typeof fetch;
}

const byId = (id: string) => auditReport("local").checks.find((c) => c.id === id)!;

before(async () => {
  setDbForTests(openDb(":memory:"));
  setPayPalFetch(fakePayPal());
  const d = db();
  const earlier = new Date(Date.now() - 3600_000).toISOString();
  d.prepare("INSERT INTO subscriptions(id, plan_id, status, created_at, updated_at) VALUES ('I-SUB1','P-1','ACTIVE',?,?)").run(now(), now());
  book({ dedupeKey: "fund:T1", kind: "FUNDING_GROSS", amountMinor: 1000, currency: "USD", refType: "subscription", refId: "I-SUB1", source: "api_sync", userId: "local" });
  book({ dedupeKey: "fundfee:T1", kind: "FUNDING_FEE", amountMinor: -79, currency: "USD", refType: "subscription", refId: "I-SUB1", source: "api_sync", userId: "local" });
  d.prepare("INSERT INTO sessions(id, started_at, last_event_at, status) VALUES ('s1', ?, ?, 'attributed')").run(now(), now());
  for (const [n, pkg] of [[1, "zod"], [2, "dayjs"]] as const) {
    d.prepare("INSERT INTO hook_events(id, session_id, dedupe_key, hook_event_name, received_at, payload_json) VALUES (?, 's1', ?, 'PostToolUse', ?, '{}')").run(n, `k${n}`, now());
    d.prepare("INSERT INTO evidence(id, session_id, hook_event_id, kind, ecosystem, package, strength, detail_json, created_at) VALUES (?, 's1', ?, 'import_added', 'npm', ?, 'strong', '{}', ?)").run(`ev_${n}_0`, n, pkg, now());
  }
  d.prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod'), ('npm','dayjs','github.com/iamkun/dayjs')").run();
  d.prepare("INSERT INTO claims(id, repo, method, github_login, paypal_receiver, status, evidence_json, created_at, verified_at) VALUES ('c1','github.com/colinhacks/zod','github_admin','colinhacks','m@example.com','verified',?,?,?)")
    .run(JSON.stringify({ permissions: { admin: true } }), earlier, earlier);
  const candidates = {
    candidates: [
      { ecosystem: "npm", name: "zod", evidence_ids: ["ev_1_0"] },
      { ecosystem: "npm", name: "dayjs", evidence_ids: ["ev_2_0"] },
    ],
    evidence: [],
    unattributed: [],
  };
  const validated = {
    weights: [
      { ecosystem: "npm", name: "zod", weight: 0.6, classification: "meaningful", evidence_ids: ["ev_1_0"], rationale: "", proposed_weight: 3 },
      { ecosystem: "npm", name: "dayjs", weight: 0.4, classification: "supporting", evidence_ids: ["ev_2_0"], rationale: "", proposed_weight: 2 },
    ],
    unallocated: 0,
    flags: [],
  };
  d.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('r1','s1',?,'llm',?,?,'[]',1)")
    .run(now(), JSON.stringify(candidates), JSON.stringify(validated));

  const { settlementId } = s.planSettlement("local");
  s.approveSettlement(settlementId);
  await s.executeSettlement(settlementId);
  await s.syncSettlement(settlementId);
});

test("an untouched payout run passes every check that has records, and says when there's nothing to check", () => {
  const r = auditReport("local");
  assert.deepEqual(r.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.failures.join("; ")}`), []);
  for (const id of ["ledger_traces_to_paypal", "pool_not_overcommitted", "payouts_to_verified_maintainers", "items_equal_allocations", "ledger_matches_payout_status", "payout_caps_respected", "paid_weights_cite_evidence", "allocations_trace_to_sessions"]) {
    assert.equal(byId(id).status, "pass", id);
  }
  // No webhook arrived and the batch is final: those checks have nothing to examine and must not claim a pass.
  assert.equal(byId("webhooks_signature_verified").status, "empty");
  assert.equal(byId("open_batches_reconciled").status, "empty");
  assert.equal(r.activity.payout_items_confirmed, 1);
});

test("a refund that leaves held money uncovered is flagged, and held money can't be paid out of it", () => {
  // The run reserved 3.61 for dayjs. A 1.00 refund drops the balance to 2.70: the hold is no longer covered.
  book({ dedupeKey: "fundrefund:T1", kind: "FUNDING_GROSS", amountMinor: -100, currency: "USD", refType: "subscription", refId: "I-SUB1", source: "api_sync", userId: "local" });
  const pool = byId("pool_not_overcommitted");
  assert.equal(pool.status, "fail");
  assert.match(pool.failures[0], /exceeds the PayPal-confirmed balance/);
  // dayjs's maintainer verifies: the next plan would pay the held 3.61, which the pool no longer has.
  db().prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, evidence_json, created_at, verified_at) VALUES ('c2','github.com/iamkun/dayjs','github_admin','d@example.com','verified','{\"permissions\":{\"admin\":true}}',?,?)").run(now(), now());
  const { settlementId } = s.planSettlement("local");
  const budget = (db().prepare("SELECT policy_json FROM settlements WHERE id = ?").get(settlementId) as { policy_json: string }).policy_json;
  assert.equal(JSON.parse(budget).checks.find((c: any) => c.id === "budget").ok, false);
  assert.throws(() => s.approveSettlement(settlementId), /Policy checks failed/);
  s.discardDrafts("local");
});

test("altering any stored record makes the matching check fail", () => {
  const d = db();
  d.prepare("UPDATE allocations SET amount_minor = amount_minor + 1 WHERE package = 'zod'").run();
  assert.equal(byId("items_equal_allocations").status, "fail");

  d.prepare("DELETE FROM ledger WHERE kind = 'PAYOUT_FEE'").run();
  assert.equal(byId("ledger_matches_payout_status").status, "fail");

  d.prepare("INSERT INTO ledger(dedupe_key, occurred_at, kind, amount_minor, currency, ref_type, ref_id, source) VALUES ('made-up', ?, 'FUNDING_GROSS', 5000, 'USD', 'topup', 'top_none', 'api_sync')").run(now());
  assert.equal(byId("ledger_traces_to_paypal").status, "fail");

  d.prepare("DELETE FROM evidence WHERE id = 'ev_1_0'").run();
  assert.equal(byId("paid_weights_cite_evidence").status, "fail");

  d.prepare("UPDATE claims SET verified_at = ? WHERE id = 'c1'").run(new Date(Date.now() + 3600_000).toISOString());
  assert.equal(byId("payouts_to_verified_maintainers").status, "fail");

  d.prepare("INSERT INTO webhook_events(id, event_type, received_at, verification_status, processed_at, raw_json) VALUES ('WH-1','PAYMENT.PAYOUTS-ITEM.SUCCEEDED',?,'FAILURE',?,'{}')").run(now(), now());
  assert.equal(byId("webhooks_signature_verified").status, "fail");
});
