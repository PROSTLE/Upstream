// Money events: one table decides where each movement travels, each is stored once, and a rolled-back one is never shown.
import "./helpers/env.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { openDb, setDbForTests, db, now, tx } = await import("../src/db.ts");
const { setPayPalFetch } = await import("../src/paypal/client.ts");
const { book } = await import("../src/ledger.ts");
const { backfillMoneyEvents, edgeFor, flowSummary, moneyContext, moneyEventsAfter, moneyEventsBetween, recordMoneyEvent, subscribe } = await import("../src/money/flow.ts");
const s = await import("../src/settlement.ts");
const { receiveWebhook } = await import("../src/paypal/events.ts");

const USD = "USD";
const tick = () => new Promise((r) => setImmediate(r));
const rows = () => db().prepare("SELECT * FROM money_events ORDER BY id").all() as any[];

beforeEach(() => setDbForTests(openDb(":memory:")));

test("every row of the map: where money travels and what it's called", () => {
  const ledger = (kind: any, amountMinor: number, refType?: string) => edgeFor({ type: "ledger", kind, amountMinor, currency: USD, refType });
  assert.deepEqual(ledger("FUNDING_GROSS", 1000, "subscription"), { from: "funders", to: "pool", label: "PayPal confirmed a $10.00 subscription payment" });
  assert.deepEqual(ledger("FUNDING_GROSS", 500, "topup"), { from: "funders", to: "pool", label: "PayPal confirmed a $5.00 top-up" });
  assert.deepEqual(ledger("FUNDING_GROSS", -1000), { from: "pool", to: "funders", label: "PayPal refunded $10.00 to the funder" });
  assert.deepEqual(ledger("FUNDING_FEE", -84), { from: "pool", to: "fees", label: "PayPal took a $0.84 fee on that payment" });
  assert.deepEqual(ledger("FUNDING_FEE", 30), { from: "fees", to: "pool", label: "PayPal returned its fee on a refund" });
  assert.deepEqual(ledger("PAYOUT_FEE", -25), { from: "pool", to: "fees", label: "PayPal took a $0.25 payout fee" });
  assert.equal(ledger("PAYOUT_SENT", -400), null, "the status events tell this");
  assert.equal(ledger("PAYOUT_RETURNED", 400), null, "the status events tell this");
  assert.equal(ledger("FUNDING_FEE", 0), null);

  assert.deepEqual(edgeFor({ type: "batch", amountMinor: 910, currency: USD, batchId: "Q8KVJG9T", payments: 3 }), { from: "pool", to: "paypal", label: "PayPal accepted payout batch Q8KVJG9T (3 payments, $9.10)" });
  assert.match(edgeFor({ type: "batch", amountMinor: 100, currency: USD, batchId: "B", payments: 1 })!.label, /\(1 payment, \$1\.00\)/);

  const status = (s2: string, previous: string | null = "PENDING", amountMinor = 400) => edgeFor({ type: "payout_status", status: s2, previous, amountMinor, currency: USD, repo: "github.com/owner/repo" });
  assert.deepEqual(status("SUCCESS"), { from: "paypal", to: "maintainers", label: "PayPal paid $4.00 to owner/repo" });
  assert.deepEqual(status("SUCCESS", "UNCLAIMED"), { from: "unclaimed", to: "maintainers", label: "The maintainer of owner/repo claimed $4.00" });
  assert.deepEqual(status("SUCCESS", "ONHOLD"), { from: "unclaimed", to: "maintainers", label: "The maintainer of owner/repo claimed $4.00" });
  assert.deepEqual(status("UNCLAIMED", "PENDING", 250), { from: "paypal", to: "unclaimed", label: "PayPal is holding $2.50 for owner/repo until the maintainer claims it (up to 30 days)" });
  assert.deepEqual(status("ONHOLD", "PENDING", 250), { from: "paypal", to: "unclaimed", label: "PayPal put $2.50 for owner/repo on hold for review" });
  for (const st of ["RETURNED", "REFUNDED", "REVERSED"]) {
    assert.deepEqual(status(st, "UNCLAIMED", 250), { from: "unclaimed", to: "held", label: "PayPal returned $2.50 for owner/repo; it's held for that repo again" });
    assert.deepEqual(status(st, "ONHOLD", 250), { from: "unclaimed", to: "held", label: "PayPal returned $2.50 for owner/repo; it's held for that repo again" });
    assert.deepEqual(status(st, "SUCCESS", 250), { from: "maintainers", to: "held", label: "PayPal returned $2.50 for owner/repo; it's held for that repo again" });
  }
  assert.deepEqual(status("FAILED"), { from: "paypal", to: "held", label: "PayPal could not pay owner/repo (FAILED). Nothing left your pool; it's held again" });
  assert.deepEqual(status("BLOCKED"), { from: "paypal", to: "held", label: "PayPal could not pay owner/repo (BLOCKED). Nothing left your pool; it's held again" });
  assert.deepEqual(status("PENDING", null), { from: null, to: null, label: "PayPal is processing $4.00 for owner/repo" });
  assert.deepEqual(status("SOMETHING_NEW"), { from: null, to: null, label: "PayPal reports SOMETHING_NEW for $4.00 to owner/repo" });

  assert.deepEqual(edgeFor({ type: "earmark", action: "approve", amountMinor: 210, currency: USD, repos: ["github.com/owner/repo"] }), { from: "pool", to: "held", label: "Held $2.10 for owner/repo until a maintainer verifies (no PayPal call)" });
  assert.deepEqual(edgeFor({ type: "earmark", action: "approve", amountMinor: 210, currency: USD, repos: ["github.com/owner/repo"], forFees: true }), { from: "pool", to: "held", label: "Held $2.10 for owner/repo until it's worth PayPal's fee (no PayPal call)" });
  assert.equal(edgeFor({ type: "earmark", action: "approve", amountMinor: 210, currency: USD, repos: ["a", "b"] })!.label, "Held $2.10 for 2 repos until they can be paid (no PayPal call)");
  assert.deepEqual(edgeFor({ type: "earmark", action: "release", amountMinor: 210, currency: USD }), { from: "held", to: "pool", label: "Hold expired: $2.10 is back in your pool (no PayPal call)" });
});

const event = (over: object = {}) => ({ userId: "local", dedupeKey: "k1", type: "ledger" as const, amountMinor: 100, currency: USD, from: "funders" as const, to: "pool" as const, label: "x", ...over });

test("the same event recorded twice gives one row, always a positive amount", () => {
  assert.ok(recordMoneyEvent(event({ amountMinor: -100 })));
  assert.equal(recordMoneyEvent(event()), null);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].amount_minor, 100);
});

test("only the pool's currency animates; anything else stays in the list", () => {
  recordMoneyEvent(event({ dedupeKey: "eur", currency: "EUR" }));
  const [row] = rows();
  assert.equal(row.from_node, null);
  assert.equal(row.to_node, null);
  assert.equal(row.currency, "EUR");
});

test("a committed event reaches its owner with fresh numbers; a rolled-back one never shows, and others hear nothing", async () => {
  const mine: any[] = [];
  const theirs: any[] = [];
  const stopMine = subscribe("local", (e) => mine.push(e));
  const stopTheirs = subscribe("u_other", (e) => theirs.push(e));
  assert.throws(() => tx(() => {
    book({ dedupeKey: "fund:GHOST", kind: "FUNDING_GROSS", amountMinor: 700, currency: USD, refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" });
    throw new Error("rolled back");
  }));
  await tick();
  assert.equal(mine.length, 0, "no ghost");
  assert.equal(rows().length, 0);

  // The rolled-back id can be reused straight away: only the real event is told, once.
  tx(() => book({ dedupeKey: "fund:T1", kind: "FUNDING_GROSS", amountMinor: 1000, currency: USD, refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" }));
  await tick();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].label, "PayPal confirmed a $10.00 subscription payment");
  assert.equal(mine[0].summary.fundingGross, 1000);
  assert.deepEqual(mine[0].paypal_ids, { transaction_id: "T1", subscription_id: "I-1" });
  assert.deepEqual(mine[0].trigger, { via: "api", action: "sync" });
  assert.equal(theirs.length, 0);
  stopMine();
  stopTheirs();
  book({ dedupeKey: "fund:T2", kind: "FUNDING_GROSS", amountMinor: 1000, currency: USD, refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" });
  await tick();
  assert.equal(mine.length, 1, "unsubscribed");
});

test("the ledger skips what status events tell, and fees get PayPal's ids", () => {
  db().prepare("INSERT INTO settlements(id, status, currency, pool_minor, planned_minor, reserved_minor, fee_reserve_minor, policy_json, created_at) VALUES ('stl1','sent','USD',0,0,0,0,'{}',?)").run(now());
  db().prepare("INSERT INTO claims(id, repo, method, status, created_at) VALUES ('c1','github.com/o/r','github_admin','verified',?)").run(now());
  db().prepare("INSERT INTO payout_items(sender_item_id, settlement_id, claim_id, repo, receiver, amount_minor, currency, note, allocation_ids_json, payout_item_id, transaction_id, updated_at) VALUES ('stl1-1','stl1','c1','github.com/o/r','secret@example.com',400,'USD','n','{}','PI1','TX1',?)").run(now());
  book({ dedupeKey: "sent:stl1-1", kind: "PAYOUT_SENT", amountMinor: -400, currency: USD, refType: "payout_item", refId: "stl1-1", source: "webhook", userId: "local" });
  book({ dedupeKey: "returned:stl1-1", kind: "PAYOUT_RETURNED", amountMinor: 400, currency: USD, refType: "payout_item", refId: "stl1-1", source: "webhook", userId: "local" });
  assert.equal(rows().length, 0);
  book({ dedupeKey: "fee:stl1-1", kind: "PAYOUT_FEE", amountMinor: -25, currency: USD, refType: "payout_item", refId: "stl1-1", source: "webhook", userId: "local" });
  const [fee] = rows();
  assert.equal(fee.to_node, "fees");
  assert.equal(fee.settlement_id, "stl1");
  assert.equal(fee.repo, "github.com/o/r");
  assert.deepEqual(JSON.parse(fee.paypal_ids_json), { payout_item_id: "PI1", transaction_id: "TX1" });
  assert.doesNotMatch(JSON.stringify(rows()), /secret@example\.com/, "an event never holds a receiver's email");
});

test("flowSummary adds what PayPal paid and what waits for a claim, and everything adds up", () => {
  book({ dedupeKey: "fund:T1", kind: "FUNDING_GROSS", amountMinor: 3000, currency: USD, refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" });
  book({ dedupeKey: "fundfee:T1", kind: "FUNDING_FEE", amountMinor: -100, currency: USD, refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" });
  db().prepare("INSERT INTO claims(id, repo, method, status, created_at) VALUES ('c1','github.com/o/r','github_admin','verified',?)").run(now());
  db().prepare("INSERT INTO settlements(id, status, batch_status, currency, pool_minor, planned_minor, reserved_minor, fee_reserve_minor, policy_json, created_at) VALUES ('stl1','sent','SUCCESS','USD',0,0,0,0,'{}',?)").run(now());
  const item = db().prepare("INSERT INTO payout_items(sender_item_id, settlement_id, claim_id, repo, receiver, amount_minor, currency, note, allocation_ids_json, transaction_status, updated_at) VALUES (?, 'stl1','c1','github.com/o/r','m@example.com',?,'USD','n','{}',?,?)");
  item.run("a", 800, "SUCCESS", now());
  item.run("b", 200, "UNCLAIMED", now());
  item.run("c", 100, "ONHOLD", now());
  item.run("d", 70, "PENDING", now());
  item.run("e", 60, "RETURNED", now());
  for (const [key, amount] of [["a", -800], ["b", -200], ["c", -100]] as const) book({ dedupeKey: `sent:${key}`, kind: "PAYOUT_SENT", amountMinor: amount, currency: USD, refType: "payout_item", refId: key, source: "api_sync", userId: "local" });
  const f = flowSummary("local");
  assert.equal(f.paidSuccess, 800);
  assert.equal(f.unclaimedAtPaypal, 300);
  const fees = -f.fundingFees - f.payoutFees;
  assert.equal(fees + f.paidSuccess + f.unclaimedAtPaypal + f.inFlight + f.reserved + f.available, f.fundingGross, "the totals line");
  assert.equal(flowSummary("u_other").fundingGross, 0, "one person's numbers");
});

test("backfill rebuilds history, marks it, and adding it again changes nothing", () => {
  const d = db();
  const t = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
  d.prepare("INSERT INTO ledger(dedupe_key, occurred_at, kind, amount_minor, currency, ref_type, ref_id, source) VALUES ('fund:T1', ?, 'FUNDING_GROSS', 1000, 'USD', 'subscription', 'I-1', 'api_sync'), ('fundfee:T1', ?, 'FUNDING_FEE', -84, 'USD', 'subscription', 'I-1', 'api_sync'), ('sent:stl1-1', ?, 'PAYOUT_SENT', -359, 'USD', 'payout_item', 'stl1-1', 'webhook'), ('fee:stl1-1', ?, 'PAYOUT_FEE', -25, 'USD', 'payout_item', 'stl1-1', 'webhook')").run(t(0), t(0), t(30), t(30));
  d.prepare("INSERT INTO claims(id, repo, method, status, created_at) VALUES ('c1','github.com/o/r','github_admin','verified',?)").run(t(0));
  d.prepare("INSERT INTO settlements(id, status, batch_status, currency, pool_minor, planned_minor, reserved_minor, fee_reserve_minor, policy_json, created_at, approved_at, sent_at, payout_batch_id) VALUES ('stl1','sent','SUCCESS','USD',0,359,359,8,'{}',?,?,?, 'BATCH1')").run(t(10), t(10), t(20));
  d.prepare("INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, updated_at) VALUES ('a1','stl1','github.com/o/held','npm','held',359,'USD','reserved','reserve','[]',?,?)").run(t(10), t(10));
  d.prepare("INSERT INTO payout_items(sender_item_id, settlement_id, claim_id, repo, receiver, amount_minor, currency, note, allocation_ids_json, payout_item_id, transaction_id, transaction_status, updated_at, status_changed_at) VALUES ('stl1-1','stl1','c1','github.com/o/r','m@example.com',359,'USD','n','{}','PI1','TX1','SUCCESS',?,?)").run(t(25), t(25));

  assert.equal(backfillMoneyEvents(), 6);
  const all = rows();
  assert.deepEqual(all.map((r) => r.label), [
    "PayPal confirmed a $10.00 subscription payment",
    "PayPal took a $0.84 fee on that payment",
    "Held $3.59 for o/held until a maintainer verifies (no PayPal call)",
    "PayPal accepted payout batch BATCH1 (1 payment, $3.59)",
    "PayPal paid $3.59 to o/r",
    "PayPal took a $0.25 payout fee",
  ], "in date order");
  assert.ok(all.every((r) => r.backfilled === 1));
  assert.equal(JSON.parse(all[2].trigger_json).via, "none");
  assert.equal(backfillMoneyEvents(), 0, "idempotent");
  assert.equal(rows().length, 6);
  // Replay reads them in the order they happened, and one payout at a time.
  assert.equal(moneyEventsBetween("local", { from: t(20), to: t(26) }).length, 2);
  assert.equal(moneyEventsBetween("local", { settlementId: "stl1" }).length, 4);
  assert.equal(moneyEventsAfter("local", all[3].id, 500).events.length, 2);
  assert.deepEqual(moneyEventsAfter("local", 0, 2).events.map((e) => e.id), [all[4].id, all[5].id], "with no id, the most recent ones");
  assert.equal(moneyEventsAfter("u_other", 0, 500).events.length, 0);
});

/** A verified webhook through the real entry point: PayPal's signature check and the item read are the only things faked. */
function fakePayPal(items: Record<string, any>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (url.pathname === "/v1/notifications/verify-webhook-signature") return json(200, { verification_status: "SUCCESS" });
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return json(201, { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING", sender_batch_header: body.sender_batch_header } });
    }
    const item = url.pathname.match(/^\/v1\/payments\/payouts-item\/(.+)$/);
    if (item) return json(200, items[item[1]]);
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  }) as typeof fetch;
}

const SIGNED = { "paypal-auth-algo": "a", "paypal-cert-url": "b", "paypal-transmission-id": "c", "paypal-transmission-sig": "d", "paypal-transmission-time": "e" };

function seedPayout() {
  const d = db();
  book({ dedupeKey: "fund:T1", kind: "FUNDING_GROSS", amountMinor: 10_500, currency: USD, refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" });
  d.prepare("INSERT INTO sessions(id, started_at, last_event_at, status) VALUES ('s1', ?, ?, 'attributed')").run(now(), now());
  d.prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod'), ('npm','dayjs','github.com/iamkun/dayjs')").run();
  d.prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, created_at, verified_at) VALUES ('clm1','github.com/colinhacks/zod','github_admin','maintainer@example.com','verified',?,?)").run(now(), now());
  const validated = { weights: [{ ecosystem: "npm", name: "zod", weight: 0.5, classification: "meaningful", evidence_ids: ["e1"], rationale: "", proposed_weight: 3 }, { ecosystem: "npm", name: "dayjs", weight: 0.4, classification: "supporting", evidence_ids: ["e2"], rationale: "", proposed_weight: 1 }], unallocated: 0.1, flags: [] };
  d.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('r1','s1',?,'llm','{}',?,'[]',1)").run(now(), JSON.stringify(validated));
}

test("a verified webhook through the real entry point records an event that says so, then a repeat changes nothing", async () => {
  setPayPalFetch(fakePayPal({}));
  seedPayout();
  const { settlementId } = s.planSettlement("local");
  s.approveSettlement(settlementId);
  const earmark = rows().find((r) => r.type === "earmark");
  assert.equal(earmark.to_node, "held");
  assert.deepEqual(JSON.parse(earmark.trigger_json), { via: "none" }, "no PayPal call");
  assert.match(earmark.label, /^Held \$\d+\.\d\d for iamkun\/dayjs until a maintainer verifies \(no PayPal call\)$/);

  await s.executeSettlement(settlementId);
  const batch = rows().find((r) => r.type === "batch");
  assert.equal(batch.from_node, "pool");
  assert.equal(batch.to_node, "paypal");
  assert.deepEqual(JSON.parse(batch.paypal_ids_json), { payout_batch_id: "PB1" });
  assert.equal(JSON.parse(batch.trigger_json).via, "api");

  const item = db().prepare("SELECT * FROM payout_items").get() as any;
  const body = JSON.stringify({
    id: "WH-EVENT-1",
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    resource: { payout_item_id: "PI1", transaction_id: "TX1", transaction_status: "SUCCESS", time_processed: "2026-11-01T10:00:00Z", payout_item_fee: { currency: USD, value: "0.25" }, payout_item: { sender_item_id: item.sender_item_id } },
  });
  assert.deepEqual(await receiveWebhook(SIGNED, body), { verified: true });
  const paid = rows().find((r) => r.type === "payout_status");
  assert.equal(paid.status_to, "SUCCESS");
  assert.equal(paid.to_node, "maintainers");
  assert.equal(paid.at, "2026-11-01T10:00:00Z", "PayPal's own time");
  assert.equal(paid.settlement_id, settlementId);
  assert.deepEqual(JSON.parse(paid.trigger_json), { via: "webhook", event_id: "WH-EVENT-1", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", verified: true });
  assert.deepEqual(JSON.parse(paid.paypal_ids_json), { payout_item_id: "PI1", transaction_id: "TX1" });
  const fee = rows().find((r) => r.kind === "PAYOUT_FEE");
  assert.equal(JSON.parse(fee.trigger_json).via, "webhook", "the fee inherits what caused it");
  assert.ok(fee.id > paid.id, "paid, then the fee");

  const count = rows().length;
  assert.deepEqual(await receiveWebhook(SIGNED, body), { duplicate: true });
  assert.equal(rows().length, count);
  assert.doesNotMatch(JSON.stringify(rows()), /maintainer@example\.com/);
});

test("an unverified webhook changes nothing, and a scheduled sync says what caused it", async () => {
  seedPayout();
  const base = fakePayPal({});
  setPayPalFetch((async (input: any, init?: any) => (new URL(String(input)).pathname.endsWith("verify-webhook-signature") ? new Response(JSON.stringify({ verification_status: "FAILURE" }), { status: 200 }) : base(input, init))) as typeof fetch);
  const before = rows().length;
  const r = await receiveWebhook(SIGNED, JSON.stringify({ id: "WH-BAD", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: {} }));
  assert.equal(r.verified, false);
  assert.equal(rows().length, before);

  moneyContext.run({ via: "api", action: "scheduled sync" }, () => book({ dedupeKey: "fund:T9", kind: "FUNDING_GROSS", amountMinor: 100, currency: USD, refType: "subscription", refId: "I-1", source: "api_sync", userId: "local" }));
  assert.deepEqual(JSON.parse(rows().at(-1).trigger_json), { via: "api", action: "scheduled sync" });
});

test("releasing an expired hold is an event, sized before the update", () => {
  seedPayout();
  const { settlementId } = s.planSettlement("local");
  s.approveSettlement(settlementId);
  db().prepare("UPDATE allocations SET expires_at = ? WHERE status = 'reserved'").run(new Date(Date.now() - 1000).toISOString());
  s.discardDrafts("local");
  db().prepare("UPDATE settlements SET status = 'held' WHERE id = ?").run(settlementId);
  s.planSettlement("local");
  const release = rows().find((r) => r.dedupe_key.startsWith("earmark:release:local:"));
  assert.ok(release, "recorded");
  assert.equal(release.from_node, "held");
  assert.equal(release.to_node, "pool");
  assert.ok(release.amount_minor > 0);
  assert.match(release.label, /^Hold expired: \$\d+\.\d\d is back in your pool \(no PayPal call\)$/);
});
