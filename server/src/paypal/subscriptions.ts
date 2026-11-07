// Subscriptions v1 through PayPal's Server SDK, which APIMatic generates (paypal/sdk.ts). The SDK has no Catalog
// Products API, so the product the plan belongs to is still created with a direct call.
// The types below describe PayPal's JSON reply (field names from PayPal's OpenAPI schemas).
import {
  ApplicationContextUserAction,
  ExperienceContextShippingPreference,
  IntervalUnit,
  PlanRequestStatus,
  TenureType,
} from "@paypal/paypal-server-sdk";
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { link, paypal } from "./client.ts";
import { viaSdk } from "./sdk.ts";

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
    const product = productId;
    const res = await viaSdk<{ id: string; status: string }>((s) =>
      s.subscriptions.createBillingPlan({
        paypalRequestId: `upstream-plan-${product}-${config.TITHE_CURRENCY}-${config.TITHE_AMOUNT}-${config.TITHE_INTERVAL_UNIT}`,
        body: {
          productId: product,
          name: `${config.TITHE_PRODUCT_NAME} (${config.TITHE_AMOUNT} ${config.TITHE_CURRENCY} / ${config.TITHE_INTERVAL_UNIT.toLowerCase()})`,
          status: PlanRequestStatus.Active,
          billingCycles: [
            {
              frequency: { intervalUnit: config.TITHE_INTERVAL_UNIT as IntervalUnit, intervalCount: 1 },
              tenureType: TenureType.Regular,
              sequence: 1,
              totalCycles: 0, // 0 = regular cycle runs until cancelled (PayPal schema)
              pricingScheme: { fixedPrice: { currencyCode: config.TITHE_CURRENCY, value: config.TITHE_AMOUNT } },
            },
          ],
          paymentPreferences: { autoBillOutstanding: true, paymentFailureThreshold: 1 },
        },
      }),
    );
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
  custom_id?: string;
  subscriber?: { email_address?: string; payer_id?: string };
  billing_info?: unknown;
  links?: { rel: string; href: string }[];
}

export async function createSubscription(userId: string): Promise<{ id: string; planId: string; approveUrl: string }> {
  const planId = activePlanId();
  if (!planId) throw new Error("No PayPal plan yet. Run `npm run setup:paypal` first.");
  const res = await viaSdk<Subscription>((s) =>
    s.subscriptions.createSubscription({
      paypalRequestId: `upstream-sub-${crypto.randomUUID()}`,
      body: {
        planId,
        customId: userId,
        applicationContext: {
          brandName: config.BRAND_NAME,
          shippingPreference: ExperienceContextShippingPreference.NoShipping,
          userAction: ApplicationContextUserAction.SubscribeNow,
          returnUrl: `${config.PUBLIC_BASE_URL}/api/funding/return`,
          cancelUrl: `${config.PUBLIC_BASE_URL}/funding?cancelled=1`,
        },
      },
    }),
  );
  const approveUrl = link(res.data, "approve");
  if (!approveUrl) throw new Error("PayPal did not return an approve link for the subscription.");
  return { id: res.data.id, planId, approveUrl };
}

export async function getSubscription(id: string) {
  return viaSdk<Subscription>((s) => s.subscriptions.getSubscription({ id }));
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
  return viaSdk<{ transactions?: SubscriptionTransaction[] }>((s) =>
    s.subscriptions.listSubscriptionTransactions({ id, startTime: start.toISOString(), endTime: end.toISOString() }),
  );
}
