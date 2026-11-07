// The Insights board's data: one person's rows only, nothing that identifies a receiver, and totals that
// agree with the books the safety checks read.
import "./helpers/env.ts";
import { before, test } from "node:test";
import assert from "node:assert/strict";

const { openDb, setDbForTests, db, now } = await import("../src/db.ts");
const { book, poolSummary } = await import("../src/ledger.ts");
const { auditReport } = await import("../src/audit.ts");
const { studioData, sharesForSession } = await import("../src/studio/data.ts");
const { ledgerTotals } = await import("../src/studio/totals.ts");

const ALICE = "u_alice";
const BOB = "u_bob";

function session(userId: string, id: string, project: string) {
  db().prepare("INSERT INTO sessions(id, cwd, project, started_at, last_event_at, status, user_id) VALUES (?,?,?,?,?,'attributed',?)").run(id, `/home/${userId}/p`, project, now(), now(), userId);
  const cands = {
    session_id: id,
    candidates: [
      { ecosystem: "npm", name: "zod", status: "used", repo: "github.com/colinhacks/zod", in_initial_manifest: true, in_final_manifest: true, evidence_ids: ["e1"], counts: {} },
      { ecosystem: "npm", name: "react", status: "present_only", repo: "github.com/facebook/react", in_initial_manifest: true, in_final_manifest: true, evidence_ids: [], counts: {} },
    ],
    evidence: [], unattributed: [], manifest: {},
  };
  const w = (name: string, weight: number) => ({ ecosystem: "npm", name, weight, proposed_weight: weight, classification: "meaningful", evidence_ids: [], rationale: "" });
  const run = (method: string, weights: unknown[], active: number) =>
    db().prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES (?,?,?,?,?,?,'[]',?)")
      .run(`run-${method}-${id}`, id, now(), method, JSON.stringify(cands), JSON.stringify({ weights, unallocated: 0, flags: [] }), active);
  run("llm", [w("zod", 0.4)], 1);
  run("baseline", [w("zod", 1)], 0);
  run("manifest", [w("zod", 0.5), w("react", 0.5)], 0);
}

before(() => {
  setDbForTests(openDb(":memory:"));
  const d = db();
  for (const [id, gh, login] of [[ALICE, "1", "alice"], [BOB, "2", "bob"]]) {
    d.prepare("INSERT INTO users(id, github_id, login, ingest_token, created_at) VALUES (?,?,?,?,?)").run(id, gh, login, `token-${login}`, now());
  }
  session(ALICE, "s-alice", "alice-app");
  session(BOB, "s-bob", "bob-secret-app");
  // A verified claim with a receiver email, a token and a GitHub login, none of which may reach the board.
  d.prepare("INSERT INTO claims(id, repo, method, github_login, token, paypal_receiver, status, evidence_json, created_at, verified_at) VALUES ('c1','github.com/colinhacks/zod','github_admin','colin','tok-secret','maintainer@example.com','verified','{\"x\":1}',?,?)").run(now(), now());
  for (const [user, stl] of [[ALICE, "stl_a"], [BOB, "stl_b"]]) {
    d.prepare("INSERT INTO settlements(id, status, currency, pool_minor, planned_minor, reserved_minor, fee_reserve_minor, policy_json, created_at, user_id) VALUES (?, 'sent', 'USD', 1000, 359, 359, 8, '{}', ?, ?)").run(stl, now(), user);
    d.prepare("INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, expires_at, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`al_${user}`, stl, user === ALICE ? "github.com/colinhacks/zod" : "github.com/bob/private-lib", "npm", user === ALICE ? "zod" : "private-lib", 359, "USD", "reserved", "reserve", "[]", now(), "2027-01-05T00:00:00Z", now(), user);
    d.prepare("INSERT INTO payout_items(sender_item_id, settlement_id, claim_id, repo, receiver, amount_minor, currency, note, allocation_ids_json, payout_item_id, transaction_id, transaction_status, fee_minor, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`${stl}-1`, stl, "c1", "github.com/colinhacks/zod", "maintainer@example.com", 200, "USD", "thanks", "[]", `PI-${user}`, `TX-${user}`, "SUCCESS", 25, now());
  }
  book({ dedupeKey: "fund:A1", kind: "FUNDING_GROSS", amountMinor: 1000, currency: "USD", refType: "subscription", refId: "I-A", source: "api_sync", userId: ALICE, occurredAt: "2026-11-02T10:00:00Z" });
  book({ dedupeKey: "fee:A1", kind: "FUNDING_FEE", amountMinor: -84, currency: "USD", source: "api_sync", userId: ALICE, occurredAt: "2026-11-02T10:00:00Z" });
  book({ dedupeKey: "sent:A1", kind: "PAYOUT_SENT", amountMinor: -200, currency: "USD", source: "api_sync", userId: ALICE, occurredAt: "2026-11-05T10:00:00Z" });
  book({ dedupeKey: "pfee:A1", kind: "PAYOUT_FEE", amountMinor: -25, currency: "USD", source: "api_sync", userId: ALICE, occurredAt: "2026-11-05T10:00:00Z" });
  book({ dedupeKey: "refund:A1", kind: "FUNDING_GROSS", amountMinor: -100, currency: "USD", source: "webhook", userId: ALICE, occurredAt: "2026-11-06T10:00:00Z" });
  book({ dedupeKey: "fund:B1", kind: "FUNDING_GROSS", amountMinor: 5000, currency: "USD", source: "api_sync", userId: BOB, occurredAt: "2026-11-03T10:00:00Z" });
});

test("a person's board holds only their own rows, in every source", () => {
  const a = studioData(ALICE).sources;
  assert.deepEqual(a.sessions.map((s) => s.id), ["s-alice"]);
  assert.ok(a.shares.every((r) => r.session_id === "s-alice"));
  assert.deepEqual(a.allocations.map((x) => x.id), ["al_u_alice"]);
  assert.deepEqual(a.payouts.map((x) => x.settlement_id), ["stl_a"]);
  assert.deepEqual(a.maintainers.map((m) => m.repo), ["colinhacks/zod"], "Bob's repo isn't listed for Alice");
  assert.deepEqual(a.ledger.map((l) => l.amount), [10, -0.84, -2, -0.25, -1]);
  const text = JSON.stringify(studioData(ALICE));
  for (const secret of ["bob-secret-app", "private-lib", "s-bob", "stl_b"]) assert.ok(!text.includes(secret), `Alice's board mentions ${secret}`);
});

test("the board carries no receiver, token, login, email or PayPal id", () => {
  const payload = studioData(ALICE);
  const banned = ["receiver", "paypal_receiver", "token", "github_login", "evidence_json", "note", "errors_json", "claim_id", "payout_item_id", "transaction_id", "ref_id", "paypal_ids_json", "email"];
  for (const rows of Object.values(payload.sources)) for (const row of rows as Record<string, unknown>[]) {
    for (const key of Object.keys(row)) assert.ok(!banned.includes(key), `field ${key} must not be sent`);
    for (const v of Object.values(row)) {
      if (typeof v !== "string") continue;
      // Scoped npm names start with "@" (e.g. @paypal/agent-toolkit); an email has text on both sides of it.
      assert.ok(!/[^\s@/]+@[^\s@]+\.[a-z]{2,}/i.test(v), `value looks like an email: ${v}`);
      assert.ok(!["tok-secret", "PI-u_alice", "TX-u_alice", "colin"].includes(v), `value leaks an identifier: ${v}`);
    }
  }
  assert.ok(!JSON.stringify(payload).includes("maintainer@example.com"));
});

test("shares hold every method, and a declared package nobody used gets a zero, not a missing row", () => {
  const rows = sharesForSession("s-alice");
  const get = (pkg: string, method: string) => rows.find((r) => r.package === pkg && r.method === method);
  assert.equal(get("zod", "llm")?.share, 0.4);
  assert.equal(get("zod", "imports")?.share, 1);
  assert.equal(get("react", "manifest")?.share, 0.5);
  assert.equal(get("react", "llm")?.share, 0, "react was declared and never used");
  assert.equal(get("react", "llm")?.in_manifest, true);
  assert.equal(get("react", "llm")?.has_evidence, false);
  assert.equal(studioData(ALICE).sources.sessions[0].packages_used, 1);
});

test("without a stored dependency-list run, the split comes from the session's own project file; without one, there is none", () => {
  const cands = (declared: boolean) => JSON.stringify({ session_id: "x", candidates: [
    { ecosystem: "npm", name: "chalk", status: "present_only", in_initial_manifest: declared, in_final_manifest: declared, evidence_ids: [], counts: {} },
    { ecosystem: "npm", name: "dayjs", status: "used", in_initial_manifest: declared, in_final_manifest: declared, evidence_ids: ["e9"], counts: {} },
  ], evidence: [], unattributed: [], manifest: {} });
  const validated = JSON.stringify({ weights: [{ ecosystem: "npm", name: "dayjs", weight: 0.4, proposed_weight: 0.4, classification: "meaningful", evidence_ids: ["e9"], rationale: "" }], unallocated: 0.6, flags: [] });
  for (const [id, declared] of [["s-old", true], ["s-nofile", false]] as const) {
    db().prepare("INSERT INTO sessions(id, cwd, project, started_at, last_event_at, status, user_id) VALUES (?,?,?,?,?,'attributed',?)").run(id, "/p", "old", now(), now(), ALICE);
    db().prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES (?,?,?,'llm',?,?,'[]',1)").run(`run-${id}`, id, now(), cands(declared), validated);
  }
  const old = sharesForSession("s-old");
  assert.equal(old.find((r) => r.package === "chalk" && r.method === "manifest")?.share, 0.5);
  assert.equal(old.find((r) => r.package === "chalk" && r.method === "llm")?.share, 0, "declared, never used");
  assert.ok(old.every((r) => r.comparable));
  const nofile = sharesForSession("s-nofile");
  assert.ok(!nofile.some((r) => r.method === "manifest"), "no project file, no dependency-list split");
  assert.ok(nofile.every((r) => !r.comparable));
  db().prepare("DELETE FROM attribution_runs WHERE session_id IN ('s-old','s-nofile')").run();
  db().prepare("DELETE FROM sessions WHERE id IN ('s-old','s-nofile')").run();
});

test("totals agree with the pool summary and carry the same safety checks as /api/audit", () => {
  const t = ledgerTotals(ALICE, "USD");
  const p = poolSummary("USD", ALICE);
  assert.equal(t.in_minor - t.refunded_minor, p.fundingGross);
  assert.equal(t.paid_minor, -(p.payoutsSent + p.returned));
  assert.equal(t.fees_minor, -(p.fundingFees + p.payoutFees));
  assert.equal(t.balance_minor, p.balance);
  assert.equal(t.held_minor, p.reserved);
  assert.deepEqual(t, { ...t, in_minor: 1000, refunded_minor: 100, paid_minor: 200, fees_minor: 109, held_minor: 359, balance_minor: 591 });
  const audit = auditReport(ALICE);
  assert.deepEqual(t.checks.map((c) => c.name), audit.checks.map((c) => c.label));
  assert.deepEqual(t.checks.map((c) => c.ok), audit.checks.map((c) => c.status !== "fail"));
});

test("totals for a period count only that period, and refuse a date they can't read", () => {
  const t = ledgerTotals(ALICE, "USD", "2026-11-05", "2026-11-05");
  assert.equal(t.in_minor, 0);
  assert.equal(t.paid_minor, 200);
  assert.equal(t.fees_minor, 25);
  assert.equal(ledgerTotals(BOB, "USD").in_minor, 5000, "Bob's totals are his own");
  assert.throws(() => ledgerTotals(ALICE, "USD", "last week"), /2026-11-01/);
});
