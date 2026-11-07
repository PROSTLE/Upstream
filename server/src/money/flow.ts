// Every money movement as an event, for the live diagram and its event list.
// Honesty rules: only PayPal-confirmed records, PayPal's reply accepting a batch, payout status changes, and Upstream's own holds (always labelled).
// Nothing is simulated, and an event never carries an email address.
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { config } from "../config.ts";
import { db, json, now } from "../db.ts";
import { poolSummary, type LedgerKind, type PoolSummary } from "../ledger.ts";
import { formatMoney } from "../money.ts";

export type FlowNode = "funders" | "pool" | "paypal" | "maintainers" | "unclaimed" | "held" | "fees";
export type Trigger = { via: "webhook"; event_id: string; event_type: string; verified: true } | { via: "api"; action: string } | { via: "none" };
export type MoneyEventType = "ledger" | "payout_status" | "batch" | "earmark";
export type PayPalIds = Partial<Record<"transaction_id" | "payout_item_id" | "payout_batch_id" | "capture_id" | "order_id" | "subscription_id", string | null | undefined>>;

/** What caused the money events recorded inside this call: a verified webhook, a read from PayPal's API, or a scheduled sync. */
export const moneyContext = new AsyncLocalStorage<Trigger>();

export type EdgeInput =
  | { type: "ledger"; kind: LedgerKind; amountMinor: number; currency: string; refType?: string | null }
  | { type: "batch"; amountMinor: number; currency: string; batchId: string; payments: number }
  | { type: "payout_status"; status: string; previous?: string | null; amountMinor: number; currency: string; repo: string }
  | { type: "earmark"; action: "approve"; amountMinor: number; currency: string; repos: string[]; forFees?: boolean }
  | { type: "earmark"; action: "release"; amountMinor: number; currency: string };

export interface Edge {
  from: FlowNode | null;
  to: FlowNode | null;
  label: string;
}

const short = (repo: string) => repo.replace("github.com/", "");
const WAITING = new Set(["UNCLAIMED", "ONHOLD"]);

/** The single map from a money movement to where it travels and what it's called. Null means it isn't shown as an event of its own. */
export function edgeFor(e: EdgeInput): Edge | null {
  const amount = formatMoney(Math.abs(e.amountMinor), e.currency);
  if (e.type === "ledger") {
    if (e.amountMinor === 0) return null;
    if (e.kind === "FUNDING_GROSS") {
      return e.amountMinor > 0
        ? { from: "funders", to: "pool", label: `PayPal confirmed a ${amount} ${e.refType === "topup" ? "top-up" : "subscription payment"}` }
        : { from: "pool", to: "funders", label: `PayPal refunded ${amount} to the funder` };
    }
    if (e.kind === "FUNDING_FEE") {
      return e.amountMinor < 0 ? { from: "pool", to: "fees", label: `PayPal took a ${amount} fee on that payment` } : { from: "fees", to: "pool", label: "PayPal returned its fee on a refund" };
    }
    if (e.kind === "PAYOUT_FEE" && e.amountMinor < 0) return { from: "pool", to: "fees", label: `PayPal took a ${amount} payout fee` };
    // PAYOUT_SENT and PAYOUT_RETURNED are told by the payout's status events, so the list doesn't show the same payout twice.
    return null;
  }
  if (e.type === "batch") return { from: "pool", to: "paypal", label: `PayPal accepted payout batch ${e.batchId} (${e.payments} payment${e.payments === 1 ? "" : "s"}, ${amount})` };
  if (e.type === "earmark") {
    if (e.action === "release") return { from: "held", to: "pool", label: `Hold expired: ${amount} is back in your pool (no PayPal call)` };
    const label =
      e.repos.length !== 1 ? `Held ${amount} for ${e.repos.length} repos until they can be paid (no PayPal call)`
      : e.forFees ? `Held ${amount} for ${short(e.repos[0])} until it's worth PayPal's fee (no PayPal call)`
      : `Held ${amount} for ${short(e.repos[0])} until a maintainer verifies (no PayPal call)`;
    return { from: "pool", to: "held", label };
  }
  const repo = short(e.repo);
  const wasWaiting = WAITING.has(e.previous ?? "");
  switch (e.status) {
    case "SUCCESS":
      return wasWaiting ? { from: "unclaimed", to: "maintainers", label: `The maintainer of ${repo} claimed ${amount}` } : { from: "paypal", to: "maintainers", label: `PayPal paid ${amount} to ${repo}` };
    case "UNCLAIMED":
      return { from: "paypal", to: "unclaimed", label: `PayPal is holding ${amount} for ${repo} until the maintainer claims it (up to 30 days)` };
    case "ONHOLD":
      return { from: "paypal", to: "unclaimed", label: `PayPal put ${amount} for ${repo} on hold for review` };
    case "RETURNED":
    case "REFUNDED":
    case "REVERSED":
      return { from: wasWaiting ? "unclaimed" : "maintainers", to: "held", label: `PayPal returned ${amount} for ${repo}; it's held for that repo again` };
    case "FAILED":
    case "BLOCKED":
      return { from: "paypal", to: "held", label: `PayPal could not pay ${repo} (${e.status}). Nothing left your pool; it's held again` };
    case "PENDING":
      return { from: null, to: null, label: `PayPal is processing ${amount} for ${repo}` };
    default:
      return { from: null, to: null, label: `PayPal reports ${e.status} for ${amount} to ${repo}` };
  }
}

export interface FlowSummary extends PoolSummary {
  paidSuccess: number;
  unclaimedAtPaypal: number;
}

export function flowSummary(userId: string, currency: string = config.TITHE_CURRENCY): FlowSummary {
  const sum = (statuses: string) =>
    Number(
      (db()
        .prepare(`SELECT COALESCE(SUM(p.amount_minor),0) AS t FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE s.user_id = ? AND p.currency = ? AND p.transaction_status IN (${statuses})`)
        .get(userId, currency) as { t: number }).t,
    );
  return { ...poolSummary(currency, userId), paidSuccess: sum("'SUCCESS'"), unclaimedAtPaypal: sum("'UNCLAIMED','ONHOLD'") };
}

export interface MoneyEventInput extends Edge {
  userId: string;
  dedupeKey: string;
  type: MoneyEventType;
  at?: string;
  amountMinor: number;
  currency: string;
  kind?: string | null;
  refType?: string | null;
  refId?: string | null;
  settlementId?: string | null;
  repo?: string | null;
  statusFrom?: string | null;
  statusTo?: string | null;
  paypalIds?: PayPalIds;
  trigger?: Trigger;
  backfilled?: boolean;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const channel = (userId: string) => `user:${userId}`;

/** Called with every committed live event of this person. Returns the function that stops it. */
export function subscribe(userId: string, fn: (event: MoneyEventJson) => void): () => void {
  emitter.on(channel(userId), fn);
  return () => emitter.off(channel(userId), fn);
}

/** Runs after the current transaction has finished. A rolled-back event no longer exists, so nobody ever sees a ghost; a reused id can't pass for it either. */
function notifyIfCommitted(id: number, dedupeKey: string) {
  try {
    const row = db().prepare("SELECT * FROM money_events WHERE id = ? AND dedupe_key = ?").get(id, dedupeKey) as MoneyEventRow | undefined;
    if (row) emitter.emit(channel(row.user_id), { ...toJson(row), summary: flowSummary(row.user_id) });
  } catch (e) {
    console.warn("money event notification failed:", e);
  }
}

/** Stores one money event, once. A problem here is logged and never stops the money movement it describes. */
export function recordMoneyEvent(e: MoneyEventInput): number | null {
  try {
    // Only the pool's own currency moves through the diagram; anything else appears in the list alone.
    const animated = e.currency === config.TITHE_CURRENCY;
    const res = db()
      .prepare(
        `INSERT OR IGNORE INTO money_events(user_id, dedupe_key, type, at, created_at, from_node, to_node, amount_minor, currency, label, kind, ref_type, ref_id, settlement_id, repo, status_from, status_to, paypal_ids_json, trigger_json, backfilled)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.userId,
        e.dedupeKey,
        e.type,
        e.at ?? now(),
        now(),
        animated ? e.from : null,
        animated ? e.to : null,
        Math.abs(e.amountMinor),
        e.currency,
        e.label,
        e.kind ?? null,
        e.refType ?? null,
        e.refId ?? null,
        e.settlementId ?? null,
        e.repo ?? null,
        e.statusFrom ?? null,
        e.statusTo ?? null,
        JSON.stringify(Object.fromEntries(Object.entries(e.paypalIds ?? {}).filter(([, v]) => v))),
        JSON.stringify(e.trigger ?? moneyContext.getStore() ?? { via: "api", action: "sync" }),
        e.backfilled ? 1 : 0,
      );
    if (Number(res.changes) === 0) return null;
    const id = Number(res.lastInsertRowid);
    if (!e.backfilled) setImmediate(() => notifyIfCommitted(id, e.dedupeKey));
    return id;
  } catch (err) {
    console.warn(`money event ${e.dedupeKey} wasn't recorded:`, err);
    return null;
  }
}

interface LedgerRow {
  id: number;
  dedupe_key: string;
  occurred_at: string;
  kind: LedgerKind;
  amount_minor: number;
  currency: string;
  ref_type: string | null;
  ref_id: string | null;
  user_id: string;
}

/** PayPal's ids for a ledger line: the transaction, capture or refund id is in its dedupe key, the rest from what it refers to. */
function ledgerIds(row: LedgerRow): { paypalIds: PayPalIds; settlementId?: string | null; repo?: string | null } {
  const id = row.dedupe_key.slice(row.dedupe_key.indexOf(":") + 1);
  if (row.ref_type === "subscription") return { paypalIds: { transaction_id: id, subscription_id: row.ref_id } };
  if (row.ref_type === "topup") {
    const t = db().prepare("SELECT order_id, capture_id FROM topups WHERE id = ?").get(row.ref_id) as { order_id: string | null; capture_id: string | null } | undefined;
    return { paypalIds: { capture_id: t?.capture_id ?? id, order_id: t?.order_id } };
  }
  const item = db().prepare("SELECT settlement_id, repo, payout_item_id, transaction_id FROM payout_items WHERE sender_item_id = ?").get(row.ref_id) as { settlement_id: string; repo: string; payout_item_id: string | null; transaction_id: string | null } | undefined;
  return { paypalIds: { payout_item_id: item?.payout_item_id, transaction_id: item?.transaction_id }, settlementId: item?.settlement_id, repo: item?.repo };
}

function ledgerEvent(row: LedgerRow, backfilled: boolean): MoneyEventInput | null {
  const edge = edgeFor({ type: "ledger", kind: row.kind, amountMinor: row.amount_minor, currency: row.currency, refType: row.ref_type });
  if (!edge) return null;
  return { ...edge, ...ledgerIds(row), userId: row.user_id, dedupeKey: `ledger:${row.id}`, type: "ledger", at: row.occurred_at, amountMinor: row.amount_minor, currency: row.currency, kind: row.kind, refType: row.ref_type, refId: row.ref_id, backfilled, ...(backfilled ? { trigger: { via: "api", action: "sync" } as Trigger } : {}) };
}

/** Called by book() for each new ledger line. */
export function recordLedgerEvent(ledgerId: number) {
  const row = db().prepare("SELECT * FROM ledger WHERE id = ?").get(ledgerId) as LedgerRow | undefined;
  const event = row && ledgerEvent(row, false);
  if (event) recordMoneyEvent(event);
}

/**
 * Rebuilds events for money that moved before events existed, so Replay works with existing history. Safe at every start:
 * dedupe keys stop anything being recorded twice. They go in date order, and the list marks them "From history".
 */
export function backfillMoneyEvents(): number {
  const d = db();
  const todo: MoneyEventInput[] = [];
  for (const row of d.prepare("SELECT * FROM ledger WHERE kind IN ('FUNDING_GROSS','FUNDING_FEE','PAYOUT_FEE')").all() as unknown as LedgerRow[]) {
    const event = ledgerEvent(row, true);
    if (event) todo.push(event);
  }
  const history: Trigger = { via: "api", action: "rebuilt from records" };
  for (const s of d.prepare("SELECT id, user_id, currency, payout_batch_id, sent_at FROM settlements WHERE payout_batch_id IS NOT NULL").all() as { id: string; user_id: string; currency: string; payout_batch_id: string; sent_at: string | null }[]) {
    const items = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS t FROM payout_items WHERE settlement_id = ?").get(s.id) as { n: number; t: number };
    const edge = edgeFor({ type: "batch", amountMinor: Number(items.t), currency: s.currency, batchId: s.payout_batch_id, payments: Number(items.n) })!;
    todo.push({ ...edge, userId: s.user_id, dedupeKey: `batch:${s.id}`, type: "batch", at: s.sent_at ?? now(), amountMinor: Number(items.t), currency: s.currency, settlementId: s.id, paypalIds: { payout_batch_id: s.payout_batch_id }, trigger: history, backfilled: true });
  }
  for (const i of d.prepare("SELECT p.*, s.user_id FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE p.transaction_status IS NOT NULL").all() as any[]) {
    const edge = edgeFor({ type: "payout_status", status: i.transaction_status, previous: null, amountMinor: i.amount_minor, currency: i.currency, repo: i.repo })!;
    todo.push({ ...edge, userId: i.user_id, dedupeKey: `payout:${i.sender_item_id}:${i.transaction_status}`, type: "payout_status", at: i.status_changed_at ?? i.updated_at, amountMinor: i.amount_minor, currency: i.currency, refType: "payout_item", refId: i.sender_item_id, settlementId: i.settlement_id, repo: i.repo, statusTo: i.transaction_status, paypalIds: { payout_item_id: i.payout_item_id, transaction_id: i.transaction_id }, trigger: history, backfilled: true });
  }
  for (const s of d.prepare("SELECT id, user_id, currency, reserved_minor, approved_at FROM settlements WHERE reserved_minor > 0 AND approved_at IS NOT NULL").all() as { id: string; user_id: string; currency: string; reserved_minor: number; approved_at: string }[]) {
    const repos = (d.prepare("SELECT DISTINCT repo FROM allocations WHERE settlement_id = ? AND target = 'reserve' AND repo IS NOT NULL").all(s.id) as { repo: string }[]).map((r) => r.repo);
    const edge = edgeFor({ type: "earmark", action: "approve", amountMinor: s.reserved_minor, currency: s.currency, repos })!;
    todo.push({ ...edge, userId: s.user_id, dedupeKey: `earmark:approve:${s.id}`, type: "earmark", at: s.approved_at, amountMinor: s.reserved_minor, currency: s.currency, settlementId: s.id, repo: repos.length === 1 ? repos[0] : null, trigger: { via: "none" }, backfilled: true });
  }
  todo.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  let added = 0;
  for (const e of todo) if (recordMoneyEvent(e) !== null) added++;
  return added;
}

export interface MoneyEventRow {
  id: number;
  user_id: string;
  type: MoneyEventType;
  at: string;
  from_node: FlowNode | null;
  to_node: FlowNode | null;
  amount_minor: number;
  currency: string;
  label: string;
  kind: string | null;
  ref_type: string | null;
  ref_id: string | null;
  settlement_id: string | null;
  repo: string | null;
  status_from: string | null;
  status_to: string | null;
  paypal_ids_json: string | null;
  trigger_json: string;
  backfilled: number;
}

export type MoneyEventJson = ReturnType<typeof toJson> & { summary?: FlowSummary };

function toJson(r: MoneyEventRow) {
  return {
    id: r.id,
    type: r.type,
    at: r.at,
    from: r.from_node,
    to: r.to_node,
    amount_minor: r.amount_minor,
    currency: r.currency,
    label: r.label,
    kind: r.kind,
    ref_type: r.ref_type,
    ref_id: r.ref_id,
    settlement_id: r.settlement_id,
    repo: r.repo,
    status_from: r.status_from,
    status_to: r.status_to,
    paypal_ids: json<PayPalIds>(r.paypal_ids_json, {}),
    trigger: json<Trigger>(r.trigger_json, { via: "none" }),
    backfilled: Boolean(r.backfilled),
  };
}

/** A person's events after an id, oldest first. With no id it's their most recent ones, still oldest first. */
export function moneyEventsAfter(userId: string, after: number, limit: number): { events: MoneyEventJson[]; more: boolean } {
  const n = Math.min(Math.max(limit, 1), 1000);
  const rows = (after > 0
    ? db().prepare("SELECT * FROM money_events WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?").all(userId, after, n + 1)
    : db().prepare("SELECT * FROM money_events WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, n)) as unknown as MoneyEventRow[];
  if (after > 0) return { events: rows.slice(0, n).map(toJson), more: rows.length > n };
  return { events: rows.reverse().map(toJson), more: false };
}

/** For Replay: events in the order they happened, optionally limited to a date range or one payout. */
export function moneyEventsBetween(userId: string, opts: { from?: string; to?: string; settlementId?: string; limit?: number }): MoneyEventJson[] {
  const where = ["user_id = ?"];
  const args: (string | number)[] = [userId];
  if (opts.from) (where.push("at >= ?"), args.push(opts.from));
  if (opts.to) (where.push("at <= ?"), args.push(opts.to));
  if (opts.settlementId) (where.push("settlement_id = ?"), args.push(opts.settlementId));
  args.push(Math.min(Math.max(opts.limit ?? 1000, 1), 1000));
  return (db().prepare(`SELECT * FROM money_events WHERE ${where.join(" AND ")} ORDER BY at, id LIMIT ?`).all(...args) as unknown as MoneyEventRow[]).map(toJson);
}

/** Where the "latest settlement" links on the diagram go. */
export function latestSettlementId(userId: string): string | null {
  return (db().prepare("SELECT id FROM settlements WHERE user_id = ? AND status NOT IN ('empty','draft') ORDER BY created_at DESC LIMIT 1").get(userId) as { id: string } | undefined)?.id ?? null;
}
