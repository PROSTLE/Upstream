// Regression tests for state guards: old claims can't take a repo back, and a run that only holds money isn't "sent".
import "./helpers/env.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { openDb, setDbForTests, db, now } = await import("../src/db.ts");
const { updateReceiver, verifyFundingTokenClaim, payableClaim } = await import("../src/claims.ts");
const { book } = await import("../src/ledger.ts");
const s = await import("../src/settlement.ts");

beforeEach(() => setDbForTests(openDb(":memory:")));

const claim = (id: string, method: string, status: string, receiver: string, token: string) =>
  db()
    .prepare("INSERT INTO claims(id, repo, method, token, paypal_receiver, status, created_at, verified_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, "github.com/o/r", method, token, receiver, status, now(), status === "pending" ? null : now());

test("a superseded GitHub claim's private token can't change the receiver or take the repo back", () => {
  claim("old", "github_admin", "superseded", "old@example.com", "tok-old");
  claim("cur", "github_admin", "verified", "cur@example.com", "tok-cur");
  assert.throws(() => updateReceiver("old", "thief@example.com", "tok-old"), /superseded/);
  assert.equal(payableClaim("github.com/o/r")?.paypal_receiver, "cur@example.com");
  // The current claim can still fix its own email.
  updateReceiver("cur", "fixed@example.com", "tok-cur");
  assert.equal(payableClaim("github.com/o/r")?.paypal_receiver, "fixed@example.com");
});

test("the public verify endpoint can't re-activate a superseded FUNDING.yml claim, and is a no-op on a verified one", async () => {
  claim("f-old", "funding_yml_token", "superseded", "old@example.com", "upc_old");
  claim("f-cur", "funding_yml_token", "verified", "cur@example.com", "upc_cur");
  // Both answers come before any GitHub request, so this needs no network.
  await assert.rejects(verifyFundingTokenClaim("f-old"), /superseded/);
  assert.equal((await verifyFundingTokenClaim("f-cur")).status, "verified");
  assert.equal(payableClaim("github.com/o/r")?.id, "f-cur");
});

test("approving a run that only holds money for unclaimed repos marks it held, not sent", () => {
  book({ dedupeKey: "fund:T1", kind: "FUNDING_GROSS", amountMinor: 1000, currency: "USD", source: "api_sync" });
  db().prepare("INSERT INTO sessions(id, started_at, last_event_at, status) VALUES ('s1', ?, ?, 'attributed')").run(now(), now());
  db().prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod')").run();
  const validated = { weights: [{ ecosystem: "npm", name: "zod", weight: 0.4, classification: "meaningful", evidence_ids: ["ev_1_0"], rationale: "", proposed_weight: 1 }], unallocated: 0.6, flags: [] };
  db()
    .prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('r1','s1',?,'llm','{}',?,'[]',1)")
    .run(now(), JSON.stringify(validated));
  const { settlementId } = s.planSettlement();
  s.approveSettlement(settlementId);
  const row = db().prepare("SELECT status, request_json FROM settlements WHERE id = ?").get(settlementId) as { status: string; request_json: string | null };
  assert.equal(row.status, "held");
  assert.equal(row.request_json, null, "no PayPal request is frozen when nothing is sent");
  const held = db().prepare("SELECT status FROM allocations WHERE settlement_id = ?").all(settlementId) as { status: string }[];
  assert.ok(held.length > 0 && held.every((a) => a.status === "reserved"));
});
