// Payouts v1 — field names follow PayPal's published OpenAPI schema
// (developer.paypal.com/api/payments.payouts-batch/v1/schema.json).
import { paypal } from "./client.ts";

export interface Money {
  currency: string;
  value: string;
}

export interface CreatePayoutRequest {
  sender_batch_header: {
    sender_batch_id: string;
    email_subject?: string;
    email_message?: string;
    recipient_type?: "EMAIL" | "PHONE" | "PAYPAL_ID";
  };
  items: {
    recipient_type: "EMAIL" | "PHONE" | "PAYPAL_ID";
    amount: Money;
    receiver: string;
    note?: string;
    sender_item_id: string;
    purpose?: string;
  }[];
}

export interface PayoutBatchHeader {
  payout_batch_id: string;
  batch_status: "DENIED" | "PENDING" | "PROCESSING" | "SUCCESS" | "CANCELED";
  time_created?: string;
  time_completed?: string;
  sender_batch_header: { sender_batch_id: string };
  amount?: Money;
  fees?: Money;
}

export interface PayoutItem {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status?:
    | "SUCCESS"
    | "FAILED"
    | "PENDING"
    | "UNCLAIMED"
    | "RETURNED"
    | "ONHOLD"
    | "BLOCKED"
    | "REFUNDED"
    | "REVERSED";
  payout_item_fee?: Money;
  payout_batch_id: string;
  sender_batch_id?: string;
  payout_item: { sender_item_id?: string; receiver: string; amount: Money };
  time_processed?: string;
  errors?: { name?: string; message?: string };
}

export async function createPayoutBatch(body: CreatePayoutRequest, requestId: string) {
  return paypal<{ batch_header: PayoutBatchHeader; links?: { rel: string; href: string }[] }>(
    "POST",
    "/v1/payments/payouts",
    { body, requestId },
  );
}

/** Reads every page of a batch (page_size max per PayPal docs is 1000). */
export async function getPayoutBatch(payoutBatchId: string) {
  const items: PayoutItem[] = [];
  let header: PayoutBatchHeader | undefined;
  for (let page = 1; ; page++) {
    const res = await paypal<{
      batch_header: PayoutBatchHeader;
      items?: PayoutItem[];
      total_pages?: number;
    }>("GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, {
      query: { page: String(page), page_size: "1000", total_required: "true" },
    });
    header = res.data.batch_header;
    items.push(...(res.data.items ?? []));
    if (!res.data.total_pages || page >= res.data.total_pages) break;
  }
  return { header: header!, items };
}

export async function getPayoutItem(payoutItemId: string) {
  return paypal<PayoutItem>("GET", `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`);
}

/** Only items in UNCLAIMED status can be cancelled (PayPal docs). */
export async function cancelPayoutItem(payoutItemId: string) {
  return paypal<PayoutItem>(
    "POST",
    `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}/cancel`,
    { body: {} },
  );
}
