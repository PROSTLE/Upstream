// Ledger totals for a period, for the Insights board and its ledger auditor. Same definitions as the
// monthly statement (paypal/statements.ts) and the pool summary (ledger.ts), in integer minor units,
// plus the safety checks /api/audit runs.
import { db } from "../db.ts";
import { auditReport } from "../audit.ts";

export interface LedgerTotals {
  currency: string;
  from: string | null;
  to: string | null;
  in_minor: number;
  paid_minor: number;
  fees_minor: number;
  held_minor: number;
  refunded_minor: number;
  balance_minor: number;
  checks: { name: string; ok: boolean; status: string }[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `from` and `to` are inclusive UTC days (YYYY-MM-DD); either may be left out. */
export function ledgerTotals(userId: string, currency: string, from?: string | null, to?: string | null): LedgerTotals {
  if (from && !DAY.test(from)) throw new Error("from looks like 2026-11-01.");
  if (to && !DAY.test(to)) throw new Error("to looks like 2026-11-30.");
  const where = ["user_id = ?", "currency = ?"];
  const args: string[] = [userId, currency];
  if (from) { where.push("substr(occurred_at, 1, 10) >= ?"); args.push(from); }
  if (to) { where.push("substr(occurred_at, 1, 10) <= ?"); args.push(to); }
  const rows = db().prepare(`SELECT kind, amount_minor FROM ledger WHERE ${where.join(" AND ")}`).all(...args) as { kind: string; amount_minor: number }[];
  const sum = (kinds: string[], test: (n: number) => boolean = () => true) =>
    rows.filter((r) => kinds.includes(r.kind) && test(Number(r.amount_minor))).reduce((a, r) => a + Number(r.amount_minor), 0);

  const heldWhere = ["user_id = ?", "currency = ?", "status = 'reserved'"];
  const heldArgs: string[] = [userId, currency];
  if (from) { heldWhere.push("substr(created_at, 1, 10) >= ?"); heldArgs.push(from); }
  if (to) { heldWhere.push("substr(created_at, 1, 10) <= ?"); heldArgs.push(to); }
  const held = db().prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS t FROM allocations WHERE ${heldWhere.join(" AND ")}`).get(...heldArgs) as { t: number };

  return {
    currency,
    from: from ?? null,
    to: to ?? null,
    in_minor: sum(["FUNDING_GROSS"], (n) => n > 0),
    refunded_minor: -sum(["FUNDING_GROSS"], (n) => n < 0),
    paid_minor: -sum(["PAYOUT_SENT", "PAYOUT_RETURNED"]),
    fees_minor: -sum(["FUNDING_FEE", "PAYOUT_FEE"]),
    held_minor: Number(held.t),
    balance_minor: rows.reduce((a, r) => a + Number(r.amount_minor), 0),
    // "empty" means there was nothing to check yet, which is not a failure.
    checks: auditReport(userId).checks.map((c) => ({ name: c.label, ok: c.status !== "fail", status: c.status })),
  };
}
