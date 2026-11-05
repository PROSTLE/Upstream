// One-time top-ups: PayPal Orders v2 with intent CAPTURE. Like the subscription, money is booked only
// from what PayPal reports on the capture (gross and paypal_fee) and its refunds, idempotently.
import { config, features } from "./config.ts";
import { db, newId, now } from "./db.ts";
import { book } from "./ledger.ts";
import { fromMinor, toMinor } from "./money.ts";
import { PayPalError, PayPalNotConfigured, runAsUser } from "./paypal/client.ts";
import { captureOrder, createOrder, getOrder, type Order } from "./paypal/orders.ts";

export interface Topup {
  id: string;
  user_id: string;
  order_id: string | null;
  amount_minor: number;
  currency: string;
  source: "dashboard" | "agent";
  note: string | null;
  status: string;
  capture_id: string | null;
  capture_status: string | null;
  approve_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const DAY = 24 * 3600 * 1000;
const get = (id: string) => db().prepare("SELECT * FROM topups WHERE id = ?").get(id) as Topup | undefined;

export function listTopups(userId: string, limit = 50): Topup[] {
  return db().prepare("SELECT * FROM topups WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit) as unknown as Topup[];
}

/** What an agent may still request in the current 24 hours, or null when agent top-ups are off. */
export function agentAllowance(userId: string): { cap_minor: number; used_minor: number; left_minor: number } | null {
  if (!features.agentTopups) return null;
  const currency = config.TITHE_CURRENCY;
  const cap = toMinor(config.POLICY_MAX_AGENT_TOPUP!, currency);
  const since = new Date(Date.now() - DAY).toISOString();
  // Every request counts, approved or not, so an agent can't fish for approvals by re-asking.
  const used = Number(
    (db().prepare("SELECT COALESCE(SUM(amount_minor),0) AS t FROM topups WHERE user_id = ? AND source = 'agent' AND currency = ? AND created_at > ?").get(userId, currency, since) as { t: number }).t,
  );
  return { cap_minor: cap, used_minor: used, left_minor: Math.max(cap - used, 0) };
}

export async function startTopup(input: { userId: string; amount: string; source: "dashboard" | "agent"; note?: string }) {
  if (!features.paypal) throw new PayPalNotConfigured();
  const currency = config.TITHE_CURRENCY;
  const amount = String(input.amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`Enter an amount in ${currency}, like 25.`);
  const minor = toMinor(amount, currency);
  if (minor <= 0) throw new Error("The amount must be more than zero.");
  if (input.source === "agent") {
    const a = agentAllowance(input.userId);
    if (!a) throw new Error("Agent top-ups are off. Set POLICY_MAX_AGENT_TOPUP on the server to allow them.");
    if (minor > a.left_minor) {
      throw new Error(`That's more than an agent may request right now: ${fromMinor(a.left_minor, currency)} ${currency} left of ${fromMinor(a.cap_minor, currency)} per 24 hours.`);
    }
  } else if (config.POLICY_MAX_TOPUP && minor > toMinor(config.POLICY_MAX_TOPUP, currency)) {
    throw new Error(`The largest one-time top-up is ${config.POLICY_MAX_TOPUP} ${currency} (POLICY_MAX_TOPUP).`);
  }
  const id = newId("top");
  const note = input.note?.trim().slice(0, 200) || null;
  db()
    .prepare("INSERT INTO topups(id, amount_minor, currency, source, note, status, created_at, updated_at, user_id) VALUES (?,?,?,?,?,'CREATING',?,?,?)")
    .run(id, minor, currency, input.source, note, now(), now(), input.userId);
  try {
    const { order, approveUrl } = await createOrder({
      id,
      value: fromMinor(minor, currency),
      currency,
      description: `${config.BRAND_NAME} pool top-up${input.source === "agent" ? " requested by your coding agent" : ""}`.slice(0, 127),
      returnUrl: `${config.PUBLIC_BASE_URL}/api/funding/topup/return?topup=${id}`,
      cancelUrl: `${config.PUBLIC_BASE_URL}/funding?topup_cancelled=${id}`,
    });
    db().prepare("UPDATE topups SET order_id = ?, status = ?, approve_url = ?, updated_at = ? WHERE id = ?").run(order.id, order.status, approveUrl, now(), id);
  } catch (e) {
    db().prepare("UPDATE topups SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?").run(String(e instanceof Error ? e.message : e), now(), id);
    throw e;
  }
  return get(id)!;
}

/** Book what PayPal says about the order's capture and refunds. Safe to call any number of times. */
export function applyOrder(topupId: string, order: Order): Topup {
  const userId = get(topupId)!.user_id;
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  db()
    .prepare("UPDATE topups SET status = ?, capture_id = COALESCE(?, capture_id), capture_status = COALESCE(?, capture_status), error = NULL, updated_at = ? WHERE id = ?")
    .run(order.status, capture?.id ?? null, capture?.status ?? null, now(), topupId);
  // A capture that was ever COMPLETED put money in; refunds take it out below. PENDING, DECLINED and FAILED book nothing.
  if (capture && (capture.status === "COMPLETED" || capture.status === "PARTIALLY_REFUNDED" || capture.status === "REFUNDED")) {
    const gross = capture.seller_receivable_breakdown?.gross_amount ?? capture.amount;
    if (gross) {
      book({
        dedupeKey: `topup:${capture.id}`,
        occurredAt: capture.create_time,
        kind: "FUNDING_GROSS",
        amountMinor: toMinor(gross.value, gross.currency_code),
        currency: gross.currency_code,
        refType: "topup",
        refId: topupId,
        memo: `One-time top-up, capture ${capture.id}`,
        source: "api_sync",
        userId,
      });
    }
    const fee = capture.seller_receivable_breakdown?.paypal_fee;
    if (fee && Number(fee.value) !== 0) {
      book({
        dedupeKey: `topupfee:${capture.id}`,
        occurredAt: capture.create_time,
        kind: "FUNDING_FEE",
        amountMinor: -Math.abs(toMinor(fee.value, fee.currency_code)),
        currency: fee.currency_code,
        refType: "topup",
        refId: topupId,
        memo: `PayPal fee on capture ${capture.id}`,
        source: "api_sync",
        userId,
      });
    }
  }
  for (const r of unit?.payments?.refunds ?? []) {
    if (r.status !== "COMPLETED") continue;
    const gross = r.seller_payable_breakdown?.gross_amount ?? r.amount;
    if (!gross) continue;
    book({
      dedupeKey: `topuprefund:${r.id}`,
      occurredAt: r.create_time,
      kind: "FUNDING_GROSS",
      amountMinor: -toMinor(gross.value, gross.currency_code),
      currency: gross.currency_code,
      refType: "topup",
      refId: topupId,
      memo: `Refund ${r.id} of a top-up`,
      source: "api_sync",
        userId,
    });
    // On a refund PayPal hands back part of its fee, so the pool loses gross minus that (seller_payable_breakdown.net_amount).
    const fee = r.seller_payable_breakdown?.paypal_fee;
    if (fee && Number(fee.value) !== 0) {
      book({
        dedupeKey: `topuprefundfee:${r.id}`,
        occurredAt: r.create_time,
        kind: "FUNDING_FEE",
        amountMinor: Math.abs(toMinor(fee.value, fee.currency_code)),
        currency: fee.currency_code,
        refType: "topup",
        refId: topupId,
        memo: `PayPal fee returned on refund ${r.id}`,
        source: "api_sync",
        userId,
      });
    }
  }
  return get(topupId)!;
}

/** Capture an approved order. The fixed request id makes a retry return the first capture instead of a second one. */
export async function captureTopup(topupId: string): Promise<Topup> {
  const t = get(topupId);
  if (!t?.order_id) throw new Error("Unknown top-up.");
  if (t.capture_id) return syncTopup(topupId);
  try {
    const orderId = t.order_id;
    const res = await runAsUser(t.user_id, () => captureOrder(orderId, `${t.id}-capture`));
    return applyOrder(t.id, res.data);
  } catch (e) {
    // e.g. ORDER_NOT_APPROVED when the payer hasn't finished, or an earlier capture already landed: read what PayPal holds.
    if (e instanceof PayPalError && e.status >= 400 && e.status < 500) {
      const synced = await syncTopup(topupId);
      if (!synced.capture_id) db().prepare("UPDATE topups SET error = ?, updated_at = ? WHERE id = ?").run(e.message, now(), topupId);
      return get(topupId)!;
    }
    throw e;
  }
}

export async function syncTopup(topupId: string): Promise<Topup> {
  const t = get(topupId);
  if (!t?.order_id) throw new Error("Unknown top-up.");
  const orderId = t.order_id;
  const res = await runAsUser(t.user_id, () => getOrder(orderId));
  return applyOrder(t.id, res.data);
}

/** Webhooks only point at a top-up; the money comes from a fresh read of the order. */
export async function topupFromWebhook(eventType: string, resource: any): Promise<string | null> {
  const ids = new Set<string>();
  const push = (v: unknown) => typeof v === "string" && v && ids.add(v);
  push(resource?.custom_id);
  push(resource?.purchase_units?.[0]?.custom_id);
  const byOrder = (orderId: unknown) =>
    typeof orderId === "string" ? (db().prepare("SELECT id FROM topups WHERE order_id = ?").get(orderId) as { id: string } | undefined)?.id : undefined;
  const byCapture = (captureId: unknown) =>
    typeof captureId === "string" ? (db().prepare("SELECT id FROM topups WHERE capture_id = ?").get(captureId) as { id: string } | undefined)?.id : undefined;
  if (eventType === "CHECKOUT.ORDER.APPROVED") push(byOrder(resource?.id));
  else {
    push(byOrder(resource?.supplementary_data?.related_ids?.order_id));
    push(byCapture(resource?.id));
    const up = (resource?.links ?? []).find((l: { rel: string }) => l.rel === "up")?.href as string | undefined;
    push(byCapture(up?.match(/\/captures\/([^/?]+)/)?.[1]));
  }
  const id = [...ids].find((x) => get(x));
  if (!id) return null;
  if (eventType === "CHECKOUT.ORDER.APPROVED") await captureTopup(id);
  else await syncTopup(id);
  if (eventType === "PAYMENT.CAPTURE.REVERSED") {
    // PayPal's docs don't say how a reversal shows on the order, so it isn't booked automatically.
    db().prepare("UPDATE topups SET error = ?, updated_at = ? WHERE id = ?").run("PayPal reported a reversal (chargeback) on this capture. Check it in PayPal; it is not booked automatically.", now(), id);
  }
  return id;
}

/** Hourly: finish orders whose payer closed the tab after approving, and pick up refunds on recent captures. */
export async function syncOpenTopups(): Promise<Record<string, unknown>> {
  const month = new Date(Date.now() - 30 * DAY).toISOString();
  const days3 = new Date(Date.now() - 3 * DAY).toISOString();
  const rows = db()
    .prepare(
      `SELECT id, status FROM topups WHERE order_id IS NOT NULL AND (
         (status = 'COMPLETED' AND created_at > ?) OR (status NOT IN ('COMPLETED','VOIDED','FAILED') AND created_at > ?))`,
    )
    .all(month, days3) as { id: string; status: string }[];
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      const t = r.status === "APPROVED" ? await captureTopup(r.id) : await syncTopup(r.id);
      out[`topup:${r.id}`] = { status: t.status, capture: t.capture_status };
    } catch (e) {
      out[`topup:${r.id}`] = { error: String(e) };
    }
  }
  return out;
}
