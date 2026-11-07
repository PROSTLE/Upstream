// Monthly funding statements as PayPal invoices, issued through PayPal's Agent Toolkit: create, send without emailing anyone,
// record each payment PayPal already confirmed, read back the result. The invoice ties each PayPal payment to where the money went.
// The toolkit has no Payouts tool, so payouts stay on the REST client in payouts.ts.
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { modelClient } from "../attribution/llm.ts";
import { config, features } from "../config.ts";
import { db, json, newId, now } from "../db.ts";
import { formatMoney, fromMinor } from "../money.ts";
import { logCall, PayPalNotConfigured } from "./client.ts";

type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PAID_STATUSES = new Set(["PAID", "MARKED_AS_PAID"]);

// The toolkit's results don't include the HTTP status or PayPal's debug id. Its requests go through a shared axios, so they're noted there.
const httpSeen = new AsyncLocalStorage<{ status?: number; debugId?: string }>();
let axiosWatched = false;

async function toolkitRunner(): Promise<ToolRunner> {
  if (!features.paypal) throw new PayPalNotConfigured();
  // Loaded on first use: it pulls in several large packages that nothing else here needs.
  const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/openai");
  if (!axiosWatched) {
    axiosWatched = true;
    const require = createRequire(import.meta.url);
    const axios = createRequire(require.resolve("@paypal/agent-toolkit/openai"))("axios");
    const note = (res: { status?: number; headers?: Record<string, string>; config?: { url?: string } } | undefined) => {
      const seen = httpSeen.getStore();
      if (!seen || !res?.config?.url?.includes("/v2/invoicing/")) return;
      seen.status = res.status;
      seen.debugId = res.headers?.["paypal-debug-id"];
    };
    axios.interceptors.response.use(
      (res: any) => {
        note(res);
        return res;
      },
      (err: any) => {
        note(err?.response);
        throw err;
      },
    );
  }
  // A new one each time: it keeps its access token for good, and a token expires after some hours.
  const kit = new PayPalAgentToolkit({
    clientId: config.PAYPAL_CLIENT_ID!,
    clientSecret: config.PAYPAL_CLIENT_SECRET!,
    configuration: { actions: { invoices: { create: true, send: true, recordPayment: true, get: true } }, context: { sandbox: config.PAYPAL_ENV !== "live" } },
  });
  return async (name, args) => (await kit.handleToolCall({ id: newId("call"), type: "function", function: { name, arguments: JSON.stringify(args) } })).content as string;
}

let runnerFactory: () => Promise<ToolRunner> = toolkitRunner;
/** Tests inject a stand-in here; production always uses PayPal's toolkit. */
export const setToolRunnerForTests = (run: ToolRunner | null) => {
  runnerFactory = run ? async () => run : toolkitRunner;
};

class ToolError extends Error {
  status?: number;
  constructor(tool: string, message: string, status?: number) {
    super(
      status === 403
        ? "PayPal hasn't given this app permission to use Invoicing. Turn on Invoicing for the app in the PayPal Developer Dashboard (Apps & Credentials, your app, Features), then issue the statement again."
        : `PayPal refused ${tool}: ${message}`,
    );
    this.status = status;
  }
}

const TOOL_HTTP: Record<string, (id: unknown) => ["GET" | "POST", string]> = {
  create_invoice: () => ["POST", "/v2/invoicing/invoices"],
  send_invoice: (id) => ["POST", `/v2/invoicing/invoices/${id}/send`],
  record_payment_for_invoice: (id) => ["POST", `/v2/invoicing/invoices/${id}/payments`],
  get_invoice: (id) => ["GET", `/v2/invoicing/invoices/${id}`],
};

/** One toolkit call: it reports failure in its answer instead of throwing, in two shapes, so both are checked. Every call goes in the PayPal audit log. */
async function callTool(run: ToolRunner, name: string, args: Record<string, unknown>): Promise<any> {
  const seen: { status?: number; debugId?: string } = {};
  const started = Date.now();
  const content = await httpSeen.run(seen, () => run(name, args));
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { error: { message: "The toolkit answered with something that isn't JSON." } };
  }
  const failure = parsed?.error ?? (parsed?.ok === false ? parsed : undefined);
  const [method, path] = TOOL_HTTP[name](args.invoice_id);
  logCall(method, path, undefined, seen.status ?? failure?.status ?? null, seen.debugId, Date.now() - started, failure ? String(failure.code ?? failure.type ?? "TOOLKIT_ERROR") : undefined);
  if (failure) throw new ToolError(name, String(failure.message ?? "no reason given"), failure.status);
  return parsed;
}

// ---------- what a statement says ----------

interface LedgerRow {
  id: number;
  dedupe_key: string;
  occurred_at: string;
  kind: string;
  amount_minor: number;
  ref_type: string | null;
}

export interface StatementPayment {
  transaction_id: string;
  kind: "subscription" | "top-up";
  date: string;
  amount_minor: number;
}

export interface Statement {
  month: string;
  currency: string;
  payments: StatementPayment[];
  received_minor: number;
  refunded_minor: number;
  paid_minor: number;
  held_minor: number;
  fees_minor: number;
}

/** A month's confirmed funding payments and what happened to the pool, in UTC months, from the ledger and allocations alone. */
export function statementFor(userId: string, month: string): Statement {
  if (!MONTH.test(month)) throw new Error("A month looks like 2026-11.");
  const currency = config.TITHE_CURRENCY;
  const rows = db().prepare("SELECT id, dedupe_key, occurred_at, kind, amount_minor, ref_type FROM ledger WHERE user_id = ? AND currency = ? AND substr(occurred_at, 1, 7) = ? ORDER BY occurred_at, id").all(userId, currency, month) as unknown as LedgerRow[];
  const sum = (kinds: string[], test: (r: LedgerRow) => boolean = () => true) => rows.filter((r) => kinds.includes(r.kind) && test(r)).reduce((a, r) => a + r.amount_minor, 0);
  const payments = rows
    .filter((r) => r.kind === "FUNDING_GROSS" && r.amount_minor > 0)
    .map((r): StatementPayment => ({
      // Booked as fund:<transaction id> or topup:<capture id>.
      transaction_id: r.dedupe_key.slice(r.dedupe_key.indexOf(":") + 1),
      kind: r.ref_type === "topup" ? "top-up" : "subscription",
      date: r.occurred_at.slice(0, 10),
      amount_minor: r.amount_minor,
    }));
  const held = db().prepare("SELECT COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE user_id = ? AND currency = ? AND status = 'reserved' AND substr(created_at, 1, 7) = ?").get(userId, currency, month) as { t: number };
  return {
    month,
    currency,
    payments,
    received_minor: sum(["FUNDING_GROSS"], (r) => r.amount_minor > 0),
    refunded_minor: -sum(["FUNDING_GROSS"], (r) => r.amount_minor < 0),
    paid_minor: -sum(["PAYOUT_SENT", "PAYOUT_RETURNED"]),
    held_minor: Number(held.t),
    fees_minor: -sum(["FUNDING_FEE", "PAYOUT_FEE"]),
  };
}

const monthName = (month: string) => new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });

function templateSummary(s: Statement): string {
  const m = (minor: number) => formatMoney(minor, s.currency);
  return `In ${monthName(s.month)}, PayPal confirmed ${m(s.received_minor)} of funding. ${m(s.paid_minor)} was paid to maintainers, ${m(s.held_minor)} is held for maintainers and ${m(s.fees_minor)} went to PayPal fees.`;
}

/** True when every number in the text is one the statement holds, so a model can't slip in a figure. */
export function numbersMatch(text: string, s: Statement): boolean {
  const amounts = [s.received_minor, s.refunded_minor, s.paid_minor, s.held_minor, s.fees_minor, ...s.payments.map((p) => p.amount_minor)].map((minor) => fromMinor(minor, s.currency));
  const allowed = new Set([...amounts, ...amounts.map((a) => String(Number(a))), String(s.payments.length), s.month.slice(0, 4)]);
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).every((n) => allowed.has(n.replace(/,/g, "")));
}

/** Two plain sentences for the invoice's note. Muse writes them when it can; the code's own wording is used if it can't, or if a number doesn't check out. */
async function summaryFor(s: Statement): Promise<string> {
  const fallback = templateSummary(s);
  if (!features.llm) return fallback;
  try {
    const response = await modelClient().messages.create({
      model: config.UPSTREAM_MODEL,
      max_tokens: 200,
      system: "Write exactly two short, plain sentences saying where this month's open-source funding went, for a person's accounting records. Use only numbers from the JSON, as dollar amounts. No advice, no adjectives.",
      messages: [{ role: "user", content: JSON.stringify({ month: monthName(s.month), currency: s.currency, payments: s.payments.length, received: fromMinor(s.received_minor, s.currency), refunded: fromMinor(s.refunded_minor, s.currency), paid_to_maintainers: fromMinor(s.paid_minor, s.currency), held_for_maintainers: fromMinor(s.held_minor, s.currency), paypal_fees: fromMinor(s.fees_minor, s.currency) }) }],
    });
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return text && numbersMatch(text, s) ? text : fallback;
  } catch {
    return fallback;
  }
}

// ---------- issuing ----------

interface StatementRow {
  id: string;
  user_id: string;
  month: string;
  invoice_id: string | null;
  status: string;
  view_url: string | null;
  recipient: string | null;
  payments_json: string;
  created_at: string;
}

const rowFor = (userId: string, month: string) => db().prepare("SELECT * FROM statements WHERE user_id = ? AND month = ?").get(userId, month) as StatementRow | undefined;

function publicRow(r: StatementRow) {
  const recorded = json<{ transaction_id: string; method: string }[]>(r.payments_json, []);
  return { id: r.id, month: r.month, invoice_id: r.invoice_id, status: r.status, paid: PAID_STATUSES.has(r.status), view_url: r.view_url, recorded, fell_back: recorded.filter((p) => p.method !== "PAYPAL").map((p) => p.transaction_id), created_at: r.created_at };
}

const issuing = new Set<string>();

/** Creates the invoice once. If a step fails, issuing again carries on from there, and a finished statement is simply returned. */
export async function issueStatement(userId: string, month: string, opts: { email?: unknown } = {}) {
  const statement = statementFor(userId, month);
  const existing = rowFor(userId, month);
  if (existing && PAID_STATUSES.has(existing.status)) return publicRow(existing);
  if (!statement.payments.length) throw new Error(`PayPal confirmed no funding payment in ${monthName(month)}, so there's nothing to put on a statement.`);
  const key = `${userId}:${month}`;
  if (issuing.has(key)) throw new Error("This statement is already being issued.");
  issuing.add(key);
  try {
    const run = await runnerFactory();
    const currency = statement.currency;
    const money = (minor: number) => ({ currency_code: currency, value: fromMinor(minor, currency) });
    let row = existing;
    if (!row) {
      const given = typeof opts.email === "string" ? opts.email.trim() : "";
      const email = given || defaultEmail(userId);
      if (!email || !EMAIL.test(email)) throw new Error("Enter the email address this statement is for.");
      const id = newId("sta");
      db().prepare("INSERT INTO statements(id, user_id, month, status, recipient, payments_json, created_at, user_note) VALUES (?,?,?,?,?,'[]',?,?)").run(id, userId, month, "CREATING", email, now(), await summaryFor(statement));
      row = rowFor(userId, month)!;
    }

    let invoiceId = row.invoice_id;
    if (!invoiceId) {
      const compact = month.replace("-", "");
      const invoice = (number: string) => ({
        currency_code: currency,
        invoice_number: number,
        reference: row!.id,
        note: `${(db().prepare("SELECT user_note FROM statements WHERE id = ?").get(row!.id) as { user_note: string }).user_note} Records: ${config.PUBLIC_BASE_URL}/funding`.slice(0, 4000),
        invoicer_business_name: config.BRAND_NAME,
        primary_recipients: [{ billing_info: { email_address: row!.recipient } }],
        items: statement.payments.map((p) => ({
          name: p.kind === "top-up" ? "One-time top-up" : "Subscription payment",
          description: `PayPal transaction ${p.transaction_id}`,
          quantity: "1",
          unit_amount: money(p.amount_minor),
          item_date: p.date,
        })),
      });
      const number = `UPS-${compact}-${userId.slice(-8)}`;
      let created: any;
      try {
        created = await callTool(run, "create_invoice", invoice(number));
      } catch (e) {
        // The number is taken by an earlier copy of these records, which PayPal remembers and this database doesn't. The statement's id makes it unique.
        if (!(e instanceof ToolError) || !/duplicate|already exists|must be unique/i.test(e.message)) throw e;
        created = await callTool(run, "create_invoice", invoice(`${number}-${row.id.slice(-6)}`));
      }
      invoiceId = created.id ?? String(created.href ?? "").split("/").pop();
      if (!invoiceId) throw new Error("PayPal created the invoice but didn't say its id.");
      db().prepare("UPDATE statements SET invoice_id = ?, status = 'DRAFT' WHERE id = ?").run(invoiceId, row.id);
    }

    const before = await callTool(run, "get_invoice", { invoice_id: invoiceId });
    if (before.status === "DRAFT") await callTool(run, "send_invoice", { invoice_id: invoiceId, send_to_recipient: false });

    const recorded = json<{ transaction_id: string; method: string }[]>(rowFor(userId, month)!.payments_json, []);
    for (const p of statement.payments) {
      if (recorded.some((r) => r.transaction_id === p.transaction_id)) continue;
      const base = { invoice_id: invoiceId, amount: money(p.amount_minor), payment_date: p.date };
      let method = "PAYPAL";
      try {
        await callTool(run, "record_payment_for_invoice", { ...base, method: "PAYPAL", payment_id: p.transaction_id });
      } catch (e) {
        // PayPal can turn down its own transaction id for a payment it didn't take through this invoice. The id still goes on the record, as a note.
        if (!(e instanceof ToolError)) throw e;
        method = "OTHER";
        await callTool(run, "record_payment_for_invoice", { ...base, method: "OTHER", note: `PayPal transaction ${p.transaction_id}` });
      }
      recorded.push({ transaction_id: p.transaction_id, method });
      db().prepare("UPDATE statements SET payments_json = ? WHERE id = ?").run(JSON.stringify(recorded), row.id);
    }

    const after = await callTool(run, "get_invoice", { invoice_id: invoiceId });
    db().prepare("UPDATE statements SET status = ?, view_url = ? WHERE id = ?").run(String(after.status ?? "UNKNOWN"), after.detail?.metadata?.recipient_view_url ?? null, row.id);
    return publicRow(rowFor(userId, month)!);
  } finally {
    issuing.delete(key);
  }
}

function defaultEmail(userId: string): string | null {
  return (db().prepare("SELECT subscriber_email FROM subscriptions WHERE user_id = ? AND subscriber_email IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(userId) as { subscriber_email: string } | undefined)?.subscriber_email ?? null;
}

/** Every month with money records, newest first, with its numbers and statement if it has one. */
export function listStatements(userId: string) {
  const months = (db().prepare("SELECT DISTINCT substr(occurred_at, 1, 7) AS month FROM ledger WHERE user_id = ? ORDER BY month DESC").all(userId) as { month: string }[]).map((r) => r.month);
  return {
    currency: config.TITHE_CURRENCY,
    default_email: defaultEmail(userId),
    months: months.map((month) => {
      const s = statementFor(userId, month);
      const row = rowFor(userId, month);
      return {
        month,
        received: fromMinor(s.received_minor, s.currency),
        paid: fromMinor(s.paid_minor, s.currency),
        held: fromMinor(s.held_minor, s.currency),
        fees: fromMinor(s.fees_minor, s.currency),
        payments: s.payments.length,
        statement: row ? publicRow(row) : null,
      };
    }),
  };
}
