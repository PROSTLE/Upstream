// The money timeline shows only its owner's records, with the dates the payout rules set.
import "./helpers/env.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { db, openDb, setDbForTests } from "../src/db.ts";
import { moneyTimeline } from "../src/money/timeline.ts";

const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();

before(() => {
  setDbForTests(openDb(":memory:"));
  const d = db();
  d.prepare("INSERT INTO users(id, created_at) VALUES ('alice', ?), ('bob', ?)").run(ago(10), ago(10));
  d.prepare("INSERT INTO ledger(dedupe_key, occurred_at, kind, amount_minor, currency, ref_type, ref_id, memo, source, user_id) VALUES ('fund:T1', ?, 'FUNDING_GROSS', 1000, 'USD', 'subscription', 'I-A', 'Subscription payment T1', 'api_sync', 'alice')").run(ago(5));
  d.prepare("INSERT INTO ledger(dedupe_key, occurred_at, kind, amount_minor, currency, ref_type, ref_id, memo, source, user_id) VALUES ('fundfee:T1', ?, 'FUNDING_FEE', -84, 'USD', 'subscription', 'I-A', 'fee', 'api_sync', 'alice')").run(ago(5));
  d.prepare("INSERT INTO ledger(dedupe_key, occurred_at, kind, amount_minor, currency, ref_type, ref_id, memo, source, user_id) VALUES ('fund:B1', ?, 'FUNDING_GROSS', 2000, 'USD', 'subscription', 'I-B', 'Bob pays', 'api_sync', 'bob')").run(ago(5));
  d.prepare("INSERT INTO subscriptions(id, plan_id, status, created_at, updated_at, raw_json, user_id) VALUES ('I-A', 'P-1', 'ACTIVE', ?, ?, ?, 'alice')").run(ago(6), ago(1), JSON.stringify({ billing_info: { next_billing_time: ahead(25) } }));
  d.prepare(`INSERT INTO settlements(id, status, currency, pool_minor, planned_minor, reserved_minor, fee_reserve_minor, sender_batch_id, payout_batch_id, policy_json, created_at, sent_at, user_id)
             VALUES ('stl_1', 'sent', 'USD', 916, 359, 359, 8, 'upstream-stl_1', 'BATCH1', '{}', ?, ?, 'alice')`).run(ago(2), ago(2));
  d.prepare(`INSERT INTO claims(id, repo, method, status, paypal_receiver, created_at, verified_at, token) VALUES ('c1', 'github.com/prostle/split-cents', 'funding_yml_token', 'verified', 'm@example.com', ?, ?, 'tok')`).run(ago(3), ago(3));
  d.prepare(`INSERT INTO payout_items(sender_item_id, settlement_id, claim_id, repo, receiver, amount_minor, currency, note, allocation_ids_json, transaction_id, transaction_status, updated_at, status_changed_at)
             VALUES ('stl_1-1', 'stl_1', 'c1', 'github.com/prostle/split-cents', 'm@example.com', 359, 'USD', 'n', '["a1"]', 'TX1', 'SUCCESS', ?, ?)`).run(ago(2), ago(2));
  const alloc = d.prepare(`INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, payout_item_ref, session_ids_json, created_at, expires_at, updated_at, user_id)
                           VALUES (?, 'stl_1', ?, 'npm', ?, ?, 'USD', ?, ?, ?, '["s1"]', ?, ?, ?, ?)`);
  alloc.run("a1", "github.com/prostle/split-cents", "split-cents", 359, "paid", "payout", "stl_1-1", ago(2), null, ago(2), "alice");
  alloc.run("a2", "github.com/colinhacks/zod", "zod", 359, "reserved", "reserve", null, ago(2), ahead(58), ago(2), "alice");
  alloc.run("a3", "github.com/react/react", "react", 999, "reserved", "reserve", null, ago(2), ahead(58), ago(2), "bob");
});

test("the timeline holds this person's payments in, their next payment, payouts and holds, and nobody else's", () => {
  const tl = moneyTimeline("alice");
  assert.deepEqual(tl.rows.map((r) => r.id).sort(), ["budget", "github.com/colinhacks/zod", "github.com/prostle/split-cents"]);
  const kinds = tl.events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["held", "next_payment", "paid", "payment_in"]);
  assert.ok(!tl.events.some((e) => e.amount_minor === 999 || e.amount_minor === 2000), "Bob's records never appear");
  assert.equal(tl.rows.find((r) => r.id === "github.com/prostle/split-cents")?.verified, true);
  assert.equal(tl.rows.find((r) => r.id === "github.com/colinhacks/zod")?.verified, false);

  const held = tl.events.find((e) => e.kind === "held")!;
  assert.equal(held.upcoming, true, "a hold that ends in the future is shown as what happens next");
  const paid = tl.events.find((e) => e.kind === "paid")!;
  assert.equal(paid.ref.batch, "BATCH1");
  assert.equal(paid.ref.transaction, "TX1");
  const next = tl.events.find((e) => e.kind === "next_payment")!;
  assert.equal(next.upcoming, true);
  assert.ok(Date.parse(tl.window.start) < Date.parse(tl.events.find((e) => e.kind === "payment_in")!.start));
  assert.ok(Date.parse(tl.window.end) > Date.parse(held.end));
});

test("an unclaimed payout shows the day it will be cancelled, from the policy", () => {
  db().prepare("UPDATE payout_items SET transaction_status = 'UNCLAIMED' WHERE sender_item_id = 'stl_1-1'").run();
  db().prepare("UPDATE allocations SET status = 'in_batch' WHERE id = 'a1'").run();
  const e = moneyTimeline("alice").events.find((x) => x.kind === "unclaimed")!;
  assert.equal(Math.round((Date.parse(e.end) - Date.parse(e.start)) / DAY), 7);
  assert.equal(e.upcoming, true);
});

test("someone with no money records gets an empty timeline", () => {
  db().prepare("INSERT INTO users(id, created_at) VALUES ('carol', ?)").run(ago(1));
  const tl = moneyTimeline("carol");
  assert.deepEqual(tl.rows, []);
  assert.deepEqual(tl.events, []);
});
