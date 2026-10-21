// Catalog Products v1 + Subscriptions v1 (field names from PayPal's OpenAPI schemas).
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { link, paypal } from "./client.ts";

export async function ensureProductAndPlan(): Promise<{ productId: string; planId: string; created: string[] }> {
  const created: string[] = [];
  const planKey = `paypal.plan_id.${config.TITHE_CURRENCY}.${config.TITHE_AMOUNT}.${config.TITHE_INTERVAL_UNIT}`;

  let productId = getSetting("paypal.product_id");
  if (!productId) {
    const res = await paypal<{ id: string }>("POST", "/v1/catalogs/products", {
      requestId: `upstream-product-${config.PAYPAL_CLIENT_ID?.slice(-8)}`,
      body: {
        name: config.TITHE_PRODUCT_NAME,
        description: `Recurring budget that ${config.BRAND_NAME} distributes to the open-source maintainers your AI coding agent relied on.`.slice(0, 256),
        type: "SERVICE",
        home_url: config.PUBLIC_BASE_URL.startsWith("https://") ? config.PUBLIC_BASE_URL : undefined,
      },
    });
    productId = res.data.id;
    setSetting("paypal.product_id", productId);
    created.push(`product ${productId}`);
  }

  let planId = getSetting(planKey);
  if (!planId) {
    const res = await paypal<{ id: string; status: string }>("POST", "/v1/billing/plans", {
      requestId: `upstream-plan-${productId}-${config.TITHE_CURRENCY}-${config.TITHE_AMOUNT}-${config.TITHE_INTERVAL_UNIT}`,
      body: {
        product_id: productId,
        name: `${config.TITHE_PRODUCT_NAME} (${config.TITHE_AMOUNT} ${config.TITHE_CURRENCY} / ${config.TITHE_INTERVAL_UNIT.toLowerCase()})`,
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: config.TITHE_INTERVAL_UNIT, interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0, // 0 = regular cycle runs until cancelled (PayPal schema)
            pricing_scheme: { fixed_price: { currency_code: config.TITHE_CURRENCY, value: config.TITHE_AMOUNT } },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
      },
    });
    planId = res.data.id;
    setSetting(planKey, planId);
    setSetting("paypal.active_plan_key", planKey);
    created.push(`plan ${planId}`);
  }
  setSetting("paypal.active_plan_key", planKey);
  return { productId, planId, created };
}

export function activePlanId(): string | undefined {
  const key = getSetting("paypal.active_plan_key");
  return key ? getSetting(key) : undefined;
}

export interface Subscription {
  id: string;
  status: "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
  plan_id: string;
  subscriber?: { email_address?: string; payer_id?: string };
  billing_info?: unknown;
  links?: { rel: string; href: string }[];
}

export async function createSubscription(): Promise<{ id: string; approveUrl: string }> {
  const planId = activePlanId();
  if (!planId) throw new Error("No PayPal plan yet. Run `npm run setup:paypal` first.");
  const res = await paypal<Subscription>("POST", "/v1/billing/subscriptions", {
    requestId: `upstream-sub-${crypto.randomUUID()}`,
    body: {
      plan_id: planId,
      application_context: {
        brand_name: config.BRAND_NAME,
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: `${config.PUBLIC_BASE_URL}/api/funding/return`,
        cancel_url: `${config.PUBLIC_BASE_URL}/funding?cancelled=1`,
      },
    },
  });
  const approveUrl = link(res.data, "approve");
  if (!approveUrl) throw new Error("PayPal did not return an approve link for the subscription.");
  return { id: res.data.id, approveUrl };
}

export async function getSubscription(id: string) {
  return paypal<Subscription>("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
}

export interface SubscriptionTransaction {
  id: string;
  status?: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
  time: string;
  amount_with_breakdown: {
    gross_amount: { currency_code: string; value: string };
    fee_amount?: { currency_code: string; value: string };
    net_amount?: { currency_code: string; value: string };
  };
}

export async function listSubscriptionTransactions(id: string, start: Date, end: Date) {
  return paypal<{ transactions?: SubscriptionTransaction[] }>(
    "GET",
    `/v1/billing/subscriptions/${encodeURIComponent(id)}/transactions`,
    { query: { start_time: start.toISOString(), end_time: end.toISOString() } },
  );
}
