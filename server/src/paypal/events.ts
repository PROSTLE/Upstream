import { db, now } from "../db.ts";
import { syncSubscription, upsertSubscription } from "../funding.ts";
import { applyPayoutItem, syncSettlement } from "../settlement.ts";
import type { PayoutItem } from "./payouts.ts";
import { verifyWebhook } from "./webhooks.ts";

interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource: any;
}

export async function receiveWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string) {
  const event = JSON.parse(rawBody) as WebhookEvent;
  if (!event.id || !event.event_type) throw new Error("Not a PayPal webhook event");
  const existing = db().prepare("SELECT processed_at, verification_status FROM webhook_events WHERE id = ?").get(event.id) as
    | { processed_at: string | null; verification_status: string }
    | undefined;
  if (existing?.processed_at) return { duplicate: true };

  const verification = await verifyWebhook(headers, rawBody);
  db()
    .prepare(
      `INSERT INTO webhook_events(id, event_type, resource_type, received_at, verification_status, raw_json) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET verification_status = excluded.verification_status`,
    )
    .run(event.id, event.event_type, event.resource_type ?? null, now(), verification, rawBody);
  // Unverified events are stored for inspection but never change money state.
  if (verification !== "SUCCESS") return { verified: false, verification };

  try {
    await processEvent(event);
    db().prepare("UPDATE webhook_events SET processed_at = ?, process_error = NULL WHERE id = ?").run(now(), event.id);
  } catch (err) {
    db().prepare("UPDATE webhook_events SET process_error = ? WHERE id = ?").run(String(err), event.id);
    throw err;
  }
  return { verified: true };
}

async function processEvent(event: WebhookEvent) {
  const t = event.event_type;
  if (t.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    applyPayoutItem(event.resource as PayoutItem, "webhook", t);
    return;
  }
  if (t.startsWith("PAYMENT.PAYOUTSBATCH.")) {
    // Batch events carry no item details (PayPal docs), so pull the batch.
    const batchId = event.resource?.batch_header?.payout_batch_id;
    const s = db().prepare("SELECT id FROM settlements WHERE payout_batch_id = ?").get(batchId) as { id: string } | undefined;
    if (s) await syncSettlement(s.id);
    return;
  }
  if (t.startsWith("BILLING.SUBSCRIPTION.")) {
    const r = event.resource;
    if (r?.id && r?.plan_id) upsertSubscription(r);
    if (r?.id) await syncSubscription(r.id);
    return;
  }
  if (t === "PAYMENT.SALE.COMPLETED") {
    // Community samples link the sale to its subscription via billing_agreement_id; PayPal's own
    // docs don't show the payload, so when it's absent or unknown we sync every subscription we hold.
    // The sync reads PayPal's transaction list and books idempotently, so this is always safe.
    const subId = event.resource?.billing_agreement_id;
    const known = db().prepare("SELECT id FROM subscriptions").all() as { id: string }[];
    const targets = subId && known.some((k) => k.id === subId) ? [subId] : known.map((k) => k.id);
    for (const id of targets) await syncSubscription(id);
  }
}
