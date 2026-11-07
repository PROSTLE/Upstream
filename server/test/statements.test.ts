// Monthly statements through PayPal's Agent Toolkit. PayPal is a stand-in here that only exists in tests; its answers have the toolkit's real shapes.
import "./helpers/env.ts";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const { openDb, setDbForTests, db, now } = await import("../src/db.ts");
const { book } = await import("../src/ledger.ts");
const { issueStatement, listStatements, numbersMatch, setToolRunnerForTests, statementFor } = await import("../src/paypal/statements.ts");

type Call = { name: string; args: any };
let calls: Call[] = [];
let invoice: { id: string; status: string; number?: string };
let refuse: (name: string, args: any) => string | null = () => null;

function runner(name: string, args: any): Promise<string> {
  calls.push({ name, args });
  const refused = refuse(name, args);
  // How the toolkit reports a PayPal error: an answer, not an exception.
  if (refused) return Promise.resolve(JSON.stringify({ ok: false, status: 422, code: "PAYPAL_API_HTTP_ERROR", message: refused }));
  if (name === "create_invoice") {
    invoice = { id: "INV2-TEST-1234-5678-9012", status: "DRAFT", number: args.invoice_number };
    return Promise.resolve(JSON.stringify({ rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${invoice.id}`, method: "GET" }));
  }
  if (name === "send_invoice") {
    invoice.status = "UNPAID";
    return Promise.resolve(JSON.stringify({ rel: "payer-view", href: "https://www.sandbox.paypal.com/invoice/p/#x" }));
  }
  if (name === "record_payment_for_invoice") {
    invoice.status = "MARKED_AS_PAID";
    return Promise.resolve(JSON.stringify({ payment_id: "EXTR-1" }));
  }
  return Promise.resolve(JSON.stringify({ id: invoice.id, status: invoice.status, detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#view" } } }));
}

const fund = (key: string, at: string, amount: number, refType = "subscription", kind: any = "FUNDING_GROSS") =>
  book({ dedupeKey: key, occurredAt: at, kind, amountMinor: amount, currency: "USD", refType, refId: "x", source: "api_sync", userId: "local" });

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  setToolRunnerForTests(runner);
  calls = [];
  refuse = () => null;
  db().prepare("INSERT INTO subscriptions(id, plan_id, status, subscriber_email, created_at, updated_at) VALUES ('I-1','P-1','ACTIVE','funder@example.com',?,?)").run(now(), now());
  fund("fund:SUB-TX-1", "2026-11-02T10:00:00Z", 2000);
  fund("fundfee:SUB-TX-1", "2026-11-02T10:00:00Z", -148, "subscription", "FUNDING_FEE");
  fund("topup:CAPTURE-22", "2026-11-09T10:00:00Z", 500, "topup");
  fund("fee:item", "2026-11-10T10:00:00Z", -25, "payout_item", "PAYOUT_FEE");
  fund("sent:item", "2026-11-10T10:00:00Z", -720, "payout_item", "PAYOUT_SENT");
  fund("fund:OLD-TX", "2026-10-02T10:00:00Z", 1000);
  db().prepare("INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, updated_at) VALUES ('a1','s','github.com/o/r','npm','r',310,'USD','reserved','reserve','[]','2026-11-11T00:00:00Z','2026-11-11T00:00:00Z')").run();
});

after(() => setToolRunnerForTests(null));

test("a statement holds only that month's confirmed payments and what happened to the pool", () => {
  const s = statementFor("local", "2026-11");
  assert.deepEqual(s.payments, [
    { transaction_id: "SUB-TX-1", kind: "subscription", date: "2026-11-02", amount_minor: 2000 },
    { transaction_id: "CAPTURE-22", kind: "top-up", date: "2026-11-09", amount_minor: 500 },
  ]);
  assert.equal(s.received_minor, 2500);
  assert.equal(s.paid_minor, 720);
  assert.equal(s.held_minor, 310);
  assert.equal(s.fees_minor, 173);
  assert.equal(statementFor("u_other", "2026-11").payments.length, 0, "one person's records");
  assert.throws(() => statementFor("local", "November"), /looks like 2026-11/);
  assert.throws(() => statementFor("local", "2026-13"), /looks like 2026-11/);
});

test("issuing goes create, send without email, record each payment, read back, and leaves PayPal's status and link", async () => {
  const r = await issueStatement("local", "2026-11");
  assert.deepEqual(calls.map((c) => c.name), ["create_invoice", "get_invoice", "send_invoice", "record_payment_for_invoice", "record_payment_for_invoice", "get_invoice"]);
  const [create] = calls;
  assert.equal(create.args.invoice_number, "UPS-202611-local");
  assert.equal(create.args.currency_code, "USD");
  assert.equal(create.args.reference, r.id);
  assert.deepEqual(create.args.primary_recipients, [{ billing_info: { email_address: "funder@example.com" } }]);
  assert.deepEqual(create.args.items.map((i: any) => [i.name, i.description, i.quantity, i.unit_amount.value, i.item_date]), [
    ["Subscription payment", "PayPal transaction SUB-TX-1", "1", "20.00", "2026-11-02"],
    ["One-time top-up", "PayPal transaction CAPTURE-22", "1", "5.00", "2026-11-09"],
  ]);
  assert.match(create.args.note, /\$7\.20 was paid to maintainers, \$3\.10 is held for maintainers and \$1\.73 went to PayPal fees\. Records: http:\/\/localhost:8787\/funding$/);
  assert.deepEqual(calls[2].args, { invoice_id: "INV2-TEST-1234-5678-9012", send_to_recipient: false });
  assert.deepEqual(calls[3].args, { invoice_id: "INV2-TEST-1234-5678-9012", amount: { currency_code: "USD", value: "20.00" }, payment_date: "2026-11-02", method: "PAYPAL", payment_id: "SUB-TX-1" });
  assert.equal(calls[4].args.payment_id, "CAPTURE-22");
  assert.equal(r.status, "MARKED_AS_PAID");
  assert.equal(r.paid, true);
  assert.equal(r.invoice_id, "INV2-TEST-1234-5678-9012");
  assert.equal(r.view_url, "https://www.sandbox.paypal.com/invoice/p/#view");
  assert.deepEqual(r.fell_back, []);
});

test("issuing again returns the same invoice and calls PayPal no more", async () => {
  const first = await issueStatement("local", "2026-11");
  const count = calls.length;
  const again = await issueStatement("local", "2026-11");
  assert.equal(again.invoice_id, first.invoice_id);
  assert.equal(again.id, first.id);
  assert.equal(calls.length, count);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM statements").get() as { n: number }).n, 1);
});

test("when PayPal turns down its own id, the payment is recorded as OTHER with the id in its note, and that's remembered", async () => {
  refuse = (name, args) => (name === "record_payment_for_invoice" && args.method === "PAYPAL" && args.payment_id === "CAPTURE-22" ? "Invalid payment id" : null);
  const r = await issueStatement("local", "2026-11");
  assert.deepEqual(r.fell_back, ["CAPTURE-22"]);
  assert.deepEqual(r.recorded, [{ transaction_id: "SUB-TX-1", method: "PAYPAL" }, { transaction_id: "CAPTURE-22", method: "OTHER" }]);
  const other = calls.find((c) => c.args.method === "OTHER")!;
  assert.equal(other.args.note, "PayPal transaction CAPTURE-22");
  assert.equal(other.args.payment_id, undefined);
  assert.equal(r.paid, true);
});

test("a failed step stops there, says why, and issuing again carries on without a second invoice or a repeated payment", async () => {
  refuse = (name) => (name === "send_invoice" ? "Service unavailable" : null);
  await assert.rejects(issueStatement("local", "2026-11"), /PayPal refused send_invoice: Service unavailable/);
  assert.equal(calls.filter((c) => c.name === "create_invoice").length, 1);
  const row = db().prepare("SELECT status, invoice_id FROM statements").get() as { status: string; invoice_id: string };
  assert.equal(row.status, "DRAFT");
  const listed = listStatements("local").months[0].statement!;
  assert.equal(listed.paid, false);

  refuse = () => null;
  const done = await issueStatement("local", "2026-11");
  assert.equal(done.paid, true);
  assert.equal(done.invoice_id, row.invoice_id);
  assert.equal(calls.filter((c) => c.name === "create_invoice").length, 1, "the same invoice");
  assert.equal(calls.filter((c) => c.name === "record_payment_for_invoice").length, 2);

  // A failure while recording: what's already recorded isn't sent twice.
  db().prepare("DELETE FROM statements").run();
  calls = [];
  refuse = (name, args) => (name === "record_payment_for_invoice" && (args.payment_id === "CAPTURE-22" || args.method === "OTHER") ? "Service unavailable" : null);
  await assert.rejects(issueStatement("local", "2026-11"), /PayPal refused record_payment_for_invoice/);
  assert.deepEqual(JSON.parse((db().prepare("SELECT payments_json FROM statements").get() as { payments_json: string }).payments_json), [{ transaction_id: "SUB-TX-1", method: "PAYPAL" }]);
  calls = [];
  refuse = () => null;
  const finished = await issueStatement("local", "2026-11");
  assert.equal(finished.paid, true);
  assert.deepEqual(calls.filter((c) => c.name === "record_payment_for_invoice").map((c) => c.args.payment_id), ["CAPTURE-22"], "only the one still missing");
  assert.equal(calls.filter((c) => c.name === "create_invoice").length, 0);
});

test("a taken invoice number gets the statement's id added, once", async () => {
  refuse = (name, args) => (name === "create_invoice" && args.invoice_number === "UPS-202611-local" ? "Invoice number already exists: DUPLICATE_INVOICE_NUMBER" : null);
  const r = await issueStatement("local", "2026-11");
  const numbers = calls.filter((c) => c.name === "create_invoice").map((c) => c.args.invoice_number);
  assert.equal(numbers.length, 2);
  assert.equal(numbers[1], `UPS-202611-local-${r.id.slice(-6)}`);
  assert.equal(r.paid, true);
});

test("nothing to report, a missing email and a bad month are all refused in plain words", async () => {
  await assert.rejects(issueStatement("local", "2026-03"), /no funding payment in March 2026/);
  assert.equal(calls.length, 0);
  db().prepare("UPDATE subscriptions SET subscriber_email = NULL").run();
  await assert.rejects(issueStatement("local", "2026-11"), /Enter the email address/);
  await assert.rejects(issueStatement("local", "2026-11", { email: "not an email" }), /Enter the email address/);
  const r = await issueStatement("local", "2026-11", { email: "books@example.com" });
  assert.equal(r.paid, true);
  assert.deepEqual(calls[0].args.primary_recipients, [{ billing_info: { email_address: "books@example.com" } }]);
});

test("an app without the Invoicing permission gets told how to turn it on, and can then finish", async () => {
  setToolRunnerForTests(async () => JSON.stringify({ ok: false, status: 403, code: "PAYPAL_API_HTTP_ERROR", message: "Authorization failed due to insufficient permissions." }));
  await assert.rejects(issueStatement("local", "2026-11"), /Turn on Invoicing for the app in the PayPal Developer Dashboard/);
  assert.equal((db().prepare("SELECT status FROM statements").get() as { status: string }).status, "CREATING");
  setToolRunnerForTests(runner);
  const r = await issueStatement("local", "2026-11");
  assert.equal(r.paid, true);
  assert.equal(r.invoice_id, "INV2-TEST-1234-5678-9012");
});

test("every toolkit call lands in the PayPal audit log, including a refusal", async () => {
  refuse = (name, args) => (name === "record_payment_for_invoice" && args.method === "PAYPAL" ? "Invalid payment id" : null);
  await issueStatement("local", "2026-11");
  const log = db().prepare("SELECT method, path, status, debug_id, error_name FROM paypal_calls ORDER BY id").all() as any[];
  assert.equal(log.length, calls.length);
  assert.deepEqual({ ...log[0] }, { method: "POST", path: "/v2/invoicing/invoices", status: null, debug_id: null, error_name: null }, "the stand-in has no HTTP status; the real toolkit's calls do");
  assert.equal(log.find((l) => l.path.endsWith("/payments") && l.error_name)!.error_name, "PAYPAL_API_HTTP_ERROR");
  assert.equal(log.find((l) => l.error_name)!.status, 422);
  assert.ok(log.some((l) => l.method === "GET" && l.path === "/v2/invoicing/invoices/INV2-TEST-1234-5678-9012"));
});

test("the list shows every month's numbers, newest first, and a toolkit failure shape it hasn't seen still counts as failure", async () => {
  const list = listStatements("local");
  assert.equal(list.default_email, "funder@example.com");
  assert.deepEqual(list.months.map((m) => m.month), ["2026-11", "2026-10"]);
  assert.deepEqual([list.months[0].received, list.months[0].paid, list.months[0].held, list.months[0].fees, list.months[0].payments], ["25.00", "7.20", "3.10", "1.73", 2]);
  assert.equal(list.months[1].received, "10.00");
  assert.equal(list.months[0].statement, null);

  setToolRunnerForTests(async () => JSON.stringify({ error: { message: "Failed to fetch access token", type: "paypal_error" } }));
  await assert.rejects(issueStatement("local", "2026-11"), /PayPal refused create_invoice: Failed to fetch access token/);
});

test("an AI summary only stands if every number in it is on the statement", () => {
  const s = statementFor("local", "2026-11");
  assert.equal(numbersMatch("In November 2026 you funded $25.00; $7.20 reached maintainers. $3.10 is held and PayPal kept $1.73.", s), true);
  assert.equal(numbersMatch("You funded $25.00 across 2 payments.", s), true);
  assert.equal(numbersMatch("You funded $26.00.", s), false, "a figure that isn't there");
  assert.equal(numbersMatch("Maintainers got 29% of it.", s), false, "a computed figure isn't on the statement");
  assert.equal(numbersMatch("No figures at all.", s), true);
});
