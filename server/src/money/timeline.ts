// The money timeline: what happened to each repository's share, and what happens next, for one person.
// Everything comes from stored records (allocations, payout items, the ledger and PayPal's subscription) and is
// drawn by Bryntum Scheduler on the Money records page. Nothing is estimated except the dates the rules set:
// a hold's release date and the day an unclaimed payout is cancelled.
import { payableClaim } from "../claims.ts";
import { config } from "../config.ts";
import { db, json } from "../db.ts";

export type TimelineKind = "payment_in" | "next_payment" | "held" | "in_flight" | "unclaimed" | "paid" | "released";

export interface TimelineRow {
  id: string;
  name: string;
  kind: "budget" | "repo";
  verified: boolean;
  packages: string[];
}

export interface TimelineEvent {
  id: string;
  resourceId: string;
  kind: TimelineKind;
  /** When it happened or starts, and when it ended or will end. */
  start: string;
  end: string;
  amount_minor: number;
  currency: string;
  /** True when the end lies in the future: a hold that will be released, a payout that may be cancelled, a payment due. */
  upcoming: boolean;
  ref: { batch?: string | null; transaction?: string | null; subscription?: string | null; memo?: string | null };
}

export interface MoneyTimeline {
  rows: TimelineRow[];
  events: TimelineEvent[];
  window: { start: string; end: string };
  now: string;
  policy: { reserve_days: number; cancel_unclaimed_after_days: number };
}

const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

interface AllocationRow {
  id: string;
  repo: string | null;
  ecosystem: string;
  package: string;
  amount_minor: number;
  currency: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  updated_at: string;
  transaction_status: string | null;
  transaction_id: string | null;
  status_changed_at: string | null;
  item_updated_at: string | null;
  sent_at: string | null;
  payout_batch_id: string | null;
}

export function moneyTimeline(userId: string): MoneyTimeline {
  const nowMs = Date.now();
  const rows = new Map<string, TimelineRow>();
  const events: TimelineEvent[] = [];
  const budget: TimelineRow = { id: "budget", name: "Your budget", kind: "budget", verified: false, packages: [] };

  // Money in: every payment PayPal confirmed, and the subscription's next payment PayPal has scheduled.
  const payments = db()
    .prepare("SELECT id, occurred_at, amount_minor, currency, ref_type, ref_id, memo FROM ledger WHERE user_id = ? AND kind = 'FUNDING_GROSS' AND amount_minor > 0 ORDER BY occurred_at")
    .all(userId) as { id: number; occurred_at: string; amount_minor: number; currency: string; ref_type: string | null; ref_id: string | null; memo: string | null }[];
  for (const p of payments) {
    events.push({
      id: `in-${p.id}`,
      resourceId: budget.id,
      kind: "payment_in",
      start: p.occurred_at,
      end: p.occurred_at,
      amount_minor: p.amount_minor,
      currency: p.currency,
      upcoming: false,
      ref: { subscription: p.ref_type === "subscription" ? p.ref_id : null, memo: p.memo },
    });
  }
  const subs = db().prepare("SELECT id, status, raw_json FROM subscriptions WHERE user_id = ? AND status = 'ACTIVE'").all(userId) as { id: string; status: string; raw_json: string | null }[];
  for (const s of subs) {
    const next = json<{ billing_info?: { next_billing_time?: string } }>(s.raw_json, {}).billing_info?.next_billing_time;
    if (!next || !(t(next) > nowMs)) continue;
    events.push({
      id: `next-${s.id}`,
      resourceId: budget.id,
      kind: "next_payment",
      start: next,
      end: next,
      amount_minor: Math.round(Number(config.TITHE_AMOUNT) * 100),
      currency: config.TITHE_CURRENCY,
      upcoming: true,
      ref: { subscription: s.id },
    });
  }
  if (events.length) rows.set(budget.id, budget);

  // Money out: each repository's allocations, from planning to paid, held, returned or released.
  const allocations = db()
    .prepare(
      `SELECT a.id, a.repo, a.ecosystem, a.package, a.amount_minor, a.currency, a.status, a.created_at, a.expires_at, a.updated_at,
              p.transaction_status, p.transaction_id, p.status_changed_at, p.updated_at AS item_updated_at, s.sent_at, s.payout_batch_id
       FROM allocations a
       LEFT JOIN payout_items p ON p.sender_item_id = a.payout_item_ref
       LEFT JOIN settlements s ON s.id = a.settlement_id
       WHERE a.user_id = ? AND a.status IN ('reserved', 'in_batch', 'paid', 'released')
       ORDER BY a.created_at`,
    )
    .all(userId) as unknown as AllocationRow[];
  for (const a of allocations) {
    const key = a.repo ?? `${a.ecosystem}:${a.package}`;
    let row = rows.get(key);
    if (!row) {
      row = { id: key, name: a.repo ? a.repo.replace(/^github\.com\//, "") : a.package, kind: "repo", verified: a.repo ? Boolean(payableClaim(a.repo)) : false, packages: [] };
      rows.set(key, row);
    }
    if (!row.packages.includes(a.package)) row.packages.push(a.package);
    const base = { resourceId: key, amount_minor: a.amount_minor, currency: a.currency, ref: { batch: a.payout_batch_id, transaction: a.transaction_id } };
    if (a.status === "reserved") {
      const until = a.expires_at ?? iso(t(a.created_at) + config.POLICY_RESERVE_DAYS * DAY);
      events.push({ ...base, id: `held-${a.id}`, kind: "held", start: a.created_at, end: until, upcoming: t(until) > nowMs });
    } else if (a.status === "in_batch") {
      const sent = a.sent_at ?? a.updated_at;
      if (a.transaction_status === "UNCLAIMED") {
        // PayPal holds it for the receiver; Upstream cancels it after the policy period and holds the money again.
        const cancelOn = iso(t(sent) + config.POLICY_CANCEL_UNCLAIMED_AFTER_DAYS * DAY);
        events.push({ ...base, id: `unclaimed-${a.id}`, kind: "unclaimed", start: sent, end: cancelOn, upcoming: t(cancelOn) > nowMs });
      } else {
        events.push({ ...base, id: `flight-${a.id}`, kind: "in_flight", start: sent, end: iso(Math.max(nowMs, t(sent))), upcoming: false });
      }
    } else if (a.status === "paid") {
      const sent = a.sent_at ?? a.created_at;
      const done = a.status_changed_at ?? a.item_updated_at ?? a.updated_at;
      events.push({ ...base, id: `paid-${a.id}`, kind: "paid", start: sent, end: t(done) >= t(sent) ? done : sent, upcoming: false });
    } else if (a.status === "released") {
      events.push({ ...base, id: `released-${a.id}`, kind: "released", start: a.created_at, end: a.updated_at, upcoming: false });
    }
  }

  const times = events.flatMap((e) => [t(e.start), t(e.end)]).filter((x) => Number.isFinite(x));
  const first = times.length ? Math.min(...times) : nowMs;
  const last = Math.max(nowMs, ...(times.length ? times : [nowMs]));
  return {
    rows: [...rows.values()],
    events,
    window: { start: iso(first - 3 * DAY), end: iso(last + 7 * DAY) },
    now: iso(nowMs),
    policy: { reserve_days: config.POLICY_RESERVE_DAYS, cancel_unclaimed_after_days: config.POLICY_CANCEL_UNCLAIMED_AFTER_DAYS },
  };
}
