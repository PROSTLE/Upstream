import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { paypal } from "./client.ts";

/** Event names exactly as listed on developer.paypal.com/api/rest/webhooks/event-names/. */
export const SUBSCRIBED_EVENTS = [
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTSBATCH.PROCESSING",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.HELD",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
] as const;

export function webhookUrl(): string {
  return `${config.PUBLIC_BASE_URL}/api/paypal/webhook`;
}

export function webhookId(): string | undefined {
  return config.PAYPAL_WEBHOOK_ID ?? getSetting("paypal.webhook_id");
}

/** Find the webhook for our URL or create it; PayPal requires a public https URL. */
export async function ensureWebhook(): Promise<{ id: string; created: boolean } | { skipped: string }> {
  const url = webhookUrl();
  if (!url.startsWith("https://")) {
    return { skipped: `PayPal only delivers webhooks to https URLs; PUBLIC_BASE_URL is ${config.PUBLIC_BASE_URL}` };
  }
  const list = await paypal<{ webhooks?: { id: string; url: string; event_types: { name: string }[] }[] }>(
    "GET",
    "/v1/notifications/webhooks",
  );
  const existing = list.data.webhooks?.find((w) => w.url === url);
  if (existing) {
    const have = new Set(existing.event_types.map((e) => e.name));
    const missing = SUBSCRIBED_EVENTS.filter((e) => !have.has(e));
    if (missing.length) {
      await paypal("PATCH", `/v1/notifications/webhooks/${existing.id}`, {
        body: [
          { op: "replace", path: "/event_types", value: SUBSCRIBED_EVENTS.map((name) => ({ name })) },
        ],
      });
    }
    setSetting("paypal.webhook_id", existing.id);
    return { id: existing.id, created: false };
  }
  const res = await paypal<{ id: string }>("POST", "/v1/notifications/webhooks", {
    body: { url, event_types: SUBSCRIBED_EVENTS.map((name) => ({ name })) },
  });
  setSetting("paypal.webhook_id", res.data.id);
  return { id: res.data.id, created: true };
}

/**
 * Verify with PayPal's verify-webhook-signature API. The raw request body is
 * spliced in byte-for-byte so re-serialisation can't break the signature.
 */
export async function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): Promise<"SUCCESS" | "FAILURE" | "NO_WEBHOOK_ID"> {
  const id = webhookId();
  if (!id) return "NO_WEBHOOK_ID";
  const h = (name: string) => {
    const v = headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const fields = {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: id,
  };
  if (Object.values(fields).some((v) => !v)) return "FAILURE";
  const prefix = JSON.stringify(fields).slice(0, -1);
  const res = await paypal<{ verification_status: "SUCCESS" | "FAILURE" }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    { rawBody: `${prefix},"webhook_event":${rawBody}}` },
  );
  return res.data.verification_status;
}
