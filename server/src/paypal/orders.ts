// Orders v2, sent through PayPal's Server SDK, which APIMatic generates (paypal/sdk.ts).
// The types below describe PayPal's JSON reply, which is what money is booked from
// (field names and enums from developer.paypal.com/api/orders/v2/schema.json).
import { CheckoutPaymentIntent, PaypalExperienceUserAction, PaypalWalletContextShippingPreference } from "@paypal/paypal-server-sdk";
import { config } from "../config.ts";
import { link } from "./client.ts";
import { viaSdk } from "./sdk.ts";

export interface Money {
  currency_code: string;
  value: string;
}

export interface Capture {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
  amount?: Money;
  custom_id?: string;
  seller_receivable_breakdown?: { gross_amount: Money; paypal_fee?: Money; net_amount?: Money };
  create_time?: string;
  update_time?: string;
}

export interface Refund {
  id: string;
  status?: "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED";
  amount?: Money;
  seller_payable_breakdown?: { gross_amount?: Money; paypal_fee?: Money; net_amount?: Money };
  create_time?: string;
}

export interface Order {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  purchase_units?: { reference_id?: string; custom_id?: string; payments?: { captures?: Capture[]; refunds?: Refund[] } }[];
  links?: { rel: string; href: string }[];
}

// "return=representation" asks PayPal for the full resource, including payments.captures and the fee breakdown.
const FULL = "return=representation";

export async function createOrder(o: { id: string; value: string; currency: string; description: string; returnUrl: string; cancelUrl: string }) {
  const res = await viaSdk<Order>((s) =>
    s.orders.createOrder({
      paypalRequestId: o.id,
      prefer: FULL,
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [{ referenceId: o.id, customId: o.id, description: o.description, amount: { currencyCode: o.currency, value: o.value } }],
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: config.BRAND_NAME,
              shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              userAction: PaypalExperienceUserAction.PayNow,
              returnUrl: o.returnUrl,
              cancelUrl: o.cancelUrl,
            },
          },
        },
      },
    }),
  );
  // With payment_source.paypal PayPal returns a "payer-action" link; older integrations return "approve".
  const approveUrl = link(res.data, "payer-action") ?? link(res.data, "approve");
  if (!approveUrl) throw new Error("PayPal did not return an approval link for the order.");
  return { order: res.data, approveUrl };
}

export async function captureOrder(orderId: string, requestId: string) {
  return viaSdk<Order>((s) => s.orders.captureOrder({ id: orderId, paypalRequestId: requestId, prefer: FULL, body: {} }));
}

export async function getOrder(orderId: string) {
  return viaSdk<Order>((s) => s.orders.getOrder({ id: orderId }));
}
