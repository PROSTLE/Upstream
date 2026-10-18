// Orders v2 (field names and enums from developer.paypal.com/api/orders/v2/schema.json).
import { config } from "../config.ts";
import { link, paypal } from "./client.ts";

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
const FULL = { Prefer: "return=representation" };

export async function createOrder(o: { id: string; value: string; currency: string; description: string; returnUrl: string; cancelUrl: string }) {
  const res = await paypal<Order>("POST", "/v2/checkout/orders", {
    requestId: o.id,
    headers: FULL,
    body: {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: o.id, custom_id: o.id, description: o.description, amount: { currency_code: o.currency, value: o.value } }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: config.BRAND_NAME,
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: o.returnUrl,
            cancel_url: o.cancelUrl,
          },
        },
      },
    },
  });
  // With payment_source.paypal PayPal returns a "payer-action" link; older integrations return "approve".
  const approveUrl = link(res.data, "payer-action") ?? link(res.data, "approve");
  if (!approveUrl) throw new Error("PayPal did not return an approval link for the order.");
  return { order: res.data, approveUrl };
}

export async function captureOrder(orderId: string, requestId: string) {
  return paypal<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId, headers: FULL, body: {} });
}

export async function getOrder(orderId: string) {
  return paypal<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}
