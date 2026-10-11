import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { book } from "./ledger.ts";
import { toMinor } from "./money.ts";
import { getSubscription, listSubscriptionTransactions } from "./paypal/subscriptions.ts";

export function upsertSubscription(s: {
  id: string;
  plan_id: string;
  status: string;
  subscriber?: { email_address?: string };
}) {
  db()
    .prepare(
      `INSERT INTO subscriptions(id, plan_id, status, subscriber_email, created_at, updated_at, raw_json)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status,
         subscriber_email = COALESCE(excluded.subscriber_email, subscriptions.subscriber_email),
         updated_at = excluded.updated_at, raw_json = excluded.raw_json`,
    )
    .run(s.id, s.plan_id, s.status, s.subscriber?.email_address ?? null, now(), now(), JSON.stringify(s));
}

/**
 * PayPal's subscription transaction list is the source of truth for money in.
 * Webhooks (PAYMENT.SALE.COMPLETED, BILLING.SUBSCRIPTION.*) only trigger this sync,
 * so a payment is never booked twice under two different ids.
 */
export async function syncSubscription(id: string): Promise<{ status: string; booked: number }> {
  const sub = await getSubscription(id);
  upsertSubscription(sub.data);
  const created = db().prepare("SELECT created_at FROM subscriptions WHERE id = ?").get(id) as
    | { created_at: string }
    | undefined;
  const start = new Date(new Date(created?.created_at ?? now()).getTime() - 24 * 3600 * 1000);
  const tx = await listSubscriptionTransactions(id, start, new Date());
  let booked = 0;
  for (const t of tx.data.transactions ?? []) {
    const gross = t.amount_with_breakdown.gross_amount;
    const fee = t.amount_with_breakdown.fee_amount;
    if (t.status === "COMPLETED" || t.status === "PARTIALLY_REFUNDED" || t.status === "REFUNDED") {
      if (
        book({
          dedupeKey: `fund:${t.id}`,
          occurredAt: t.time,
          kind: "FUNDING_GROSS",
          amountMinor: toMinor(gross.value, gross.currency_code),
          currency: gross.currency_code,
          refType: "subscription",
          refId: id,
          memo: `Subscription payment ${t.id}`,
          source: "api_sync",
        })
      )
        booked++;
      if (fee && Number(fee.value) !== 0) {
        book({
          dedupeKey: `fundfee:${t.id}`,
          occurredAt: t.time,
          kind: "FUNDING_FEE",
          amountMinor: -Math.abs(toMinor(fee.value, fee.currency_code)),
          currency: fee.currency_code,
          refType: "subscription",
          refId: id,
          memo: `PayPal fee on ${t.id}`,
          source: "api_sync",
        });
      }
    }
    if (t.status === "REFUNDED") {
      // A full refund takes the gross back out; PayPal's response does not break out fee returns here.
      book({
        dedupeKey: `fundrefund:${t.id}`,
        occurredAt: t.time,
        kind: "FUNDING_GROSS",
        amountMinor: -toMinor(gross.value, gross.currency_code),
        currency: gross.currency_code,
        refType: "subscription",
        refId: id,
        memo: `Refund of ${t.id}`,
        source: "api_sync",
      });
    }
  }
  return { status: sub.data.status, booked };
}

export function currentSubscription() {
  return db()
    .prepare("SELECT * FROM subscriptions ORDER BY updated_at DESC LIMIT 1")
    .get() as
    | { id: string; plan_id: string; status: string; subscriber_email: string | null; updated_at: string }
    | undefined;
}

export const fundingCurrency = () => config.TITHE_CURRENCY;
