import { db, now } from "./db.ts";

export type LedgerKind =
  | "FUNDING_GROSS"
  | "FUNDING_FEE"
  | "PAYOUT_SENT"
  | "PAYOUT_FEE"
  | "PAYOUT_RETURNED";

/** Idempotent: the same dedupe key is only ever booked once. */
export function book(entry: {
  dedupeKey: string;
  occurredAt?: string;
  kind: LedgerKind;
  amountMinor: number;
  currency: string;
  refType?: string;
  refId?: string;
  memo?: string;
  source: "webhook" | "api_sync";
}): boolean {
  const res = db()
    .prepare(
      `INSERT OR IGNORE INTO ledger(dedupe_key, occurred_at, kind, amount_minor, currency, ref_type, ref_id, memo, source)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      entry.dedupeKey,
      entry.occurredAt ?? now(),
      entry.kind,
      entry.amountMinor,
      entry.currency,
      entry.refType ?? null,
      entry.refId ?? null,
      entry.memo ?? null,
      entry.source,
    );
  return Number(res.changes) > 0;
}

export interface PoolSummary {
  currency: string;
  fundingGross: number;
  fundingFees: number;
  payoutsSent: number;
  payoutFees: number;
  returned: number;
  balance: number; // money actually in the pool according to PayPal-confirmed movements
  reserved: number; // earmarked for repos without a verified maintainer yet
  inFlight: number; // in a batch that PayPal has not finished
  available: number; // what the next settlement may allocate
  /** balance - reserved - inFlight, not clamped: negative when PayPal's actual fees or a refund left earmarks larger than the money. */
  headroom: number;
}

export function poolSummary(currency: string): PoolSummary {
  const sums = db()
    .prepare("SELECT kind, COALESCE(SUM(amount_minor),0) AS total FROM ledger WHERE currency = ? GROUP BY kind")
    .all(currency) as { kind: LedgerKind; total: number }[];
  const by = (k: LedgerKind) => Number(sums.find((s) => s.kind === k)?.total ?? 0);
  const fundingGross = by("FUNDING_GROSS");
  const fundingFees = by("FUNDING_FEE");
  const payoutsSent = by("PAYOUT_SENT");
  const payoutFees = by("PAYOUT_FEE");
  const returned = by("PAYOUT_RETURNED");
  const balance = fundingGross + fundingFees + payoutsSent + payoutFees + returned;

  // Allocation lifecycle: planned (draft only, not counted) -> reserved | in_batch -> paid,
  // and back to reserved when PayPal returns or fails an item.
  const alloc = db()
    .prepare(
      "SELECT status, COALESCE(SUM(amount_minor),0) AS total FROM allocations WHERE currency = ? AND status IN ('reserved','in_batch') GROUP BY status",
    )
    .all(currency) as { status: string; total: number }[];
  const reserved = Number(alloc.find((a) => a.status === "reserved")?.total ?? 0);
  // Until PayPal reports the real fees of an open batch, keep its fee reserve out of the pool.
  // Fees PayPal has already reported (booked as negative PAYOUT_FEE) are deducted from the hold.
  const feeHold = db()
    .prepare(
      `SELECT COALESCE(SUM(MAX(s.fee_reserve_minor + COALESCE((
           SELECT SUM(l.amount_minor) FROM ledger l
           WHERE l.kind = 'PAYOUT_FEE' AND l.ref_id IN (SELECT p.sender_item_id FROM payout_items p WHERE p.settlement_id = s.id)
         ), 0), 0)), 0) AS total
       FROM settlements s
       WHERE s.currency = ? AND s.status IN ('approved','sending','sent')
         AND COALESCE(s.batch_status,'') NOT IN ('SUCCESS','DENIED','CANCELED')`,
    )
    .get(currency) as { total: number };
  const inFlight =
    Number(alloc.find((a) => a.status === "in_batch")?.total ?? 0) + Number(feeHold.total);

  return {
    currency,
    fundingGross,
    fundingFees,
    payoutsSent,
    payoutFees,
    returned,
    balance,
    reserved,
    inFlight,
    available: Math.max(balance - reserved - inFlight, 0),
    headroom: balance - reserved - inFlight,
  };
}

export function ledgerEntries(limit = 500) {
  return db().prepare("SELECT * FROM ledger ORDER BY occurred_at DESC, id DESC LIMIT ?").all(limit);
}
