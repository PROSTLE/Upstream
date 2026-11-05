import { config } from "./config.ts";
import { db, LOCAL_USER, now } from "./db.ts";
import { book } from "./ledger.ts";
import { toMinor } from "./money.ts";
import { runAsUser } from "./paypal/client.ts";
import { activePlanId, createSubscription, ensureProductAndPlan, getSubscription, listSubscriptionTransactions } from "./paypal/subscriptions.ts";
import { userById } from "./users.ts";

export function subscriptionOwner(id: string): string | undefined {
  return (db().prepare("SELECT user_id FROM subscriptions WHERE id = ?").get(id) as { user_id: string } | undefined)?.user_id;
}

/** The owner is recorded before the person even sees PayPal, so a later payment can only ever land in their own space. */
export async function startSubscription(userId: string) {
  await ensureProductAndPlan();
  const { id, planId, approveUrl } = await createSubscription(userId);
  db()
    .prepare("INSERT INTO subscriptions(id, plan_id, status, created_at, updated_at, user_id) VALUES (?,?,'APPROVAL_PENDING',?,?,?)")
    .run(id, planId ?? activePlanId(), now(), now(), userId);
  return { id, approveUrl };
}

/** Saves PayPal's view of a subscription. Returns false for one that belongs to nobody here, which is then ignored. */
export function upsertSubscription(s: {
  id: string;
  plan_id: string;
  status: string;
  custom_id?: string;
  subscriber?: { email_address?: string };
}): boolean {
  const owner = subscriptionOwner(s.id) ?? (s.custom_id && userById(s.custom_id) ? s.custom_id : undefined);
  if (!owner) return false;
  db()
    .prepare(
      `INSERT INTO subscriptions(id, plan_id, status, subscriber_email, created_at, updated_at, raw_json, user_id)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status,
         subscriber_email = COALESCE(excluded.subscriber_email, subscriptions.subscriber_email),
         updated_at = excluded.updated_at, raw_json = excluded.raw_json`,
    )
    .run(s.id, s.plan_id, s.status, s.subscriber?.email_address ?? null, now(), now(), JSON.stringify(s), owner);
  return true;
}

/**
 * PayPal's subscription transaction list is the source of truth for money in.
 * Webhooks (PAYMENT.SALE.COMPLETED, BILLING.SUBSCRIPTION.*) only trigger this sync,
 * so a payment is never booked twice under two different ids.
 */
export function syncSubscription(id: string): Promise<{ status: string; booked: number }> {
  return runAsUser(subscriptionOwner(id) ?? LOCAL_USER, () => readSubscription(id));
}

async function readSubscription(id: string): Promise<{ status: string; booked: number }> {
  const sub = await getSubscription(id);
  if (!upsertSubscription(sub.data)) throw new Error("This subscription isn't linked to an account on this server.");
  const userId = subscriptionOwner(id)!;
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
          userId,
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
          userId,
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
          userId,
      });
    }
  }
  return { status: sub.data.status, booked };
}

/** Pulls PayPal's transaction list for the given subscription, or for every one we hold when it's absent or unknown. */
export async function syncKnownSubscriptions(preferId?: string): Promise<Record<string, unknown>> {
  const known = db().prepare("SELECT id FROM subscriptions").all() as { id: string }[];
  const targets = preferId && known.some((k) => k.id === preferId) ? [preferId] : known.map((k) => k.id);
  const out: Record<string, unknown> = {};
  for (const id of targets) {
    try {
      out[`subscription:${id}`] = await syncSubscription(id);
    } catch (e) {
      out[`subscription:${id}`] = { error: String(e) };
    }
  }
  return out;
}

export function currentSubscription(userId: string) {
  return db()
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1")
    .get(userId) as
    | { id: string; plan_id: string; status: string; subscriber_email: string | null; updated_at: string }
    | undefined;
}

export const fundingCurrency = () => config.TITHE_CURRENCY;
