// Settlement = turn attributed sessions into one guarded, idempotent PayPal Payouts batch.
import { activeRun } from "./attribution/run.ts";
import { markReceiverUnclaimed, payableClaim } from "./claims.ts";
import { cleanupExpiredChecks } from "./check.ts";
import { config } from "./config.ts";
import { db, isCheckUser, json, newId, now, tx } from "./db.ts";
import { syncKnownSubscriptions } from "./funding.ts";
import { syncOpenTopups } from "./topups.ts";
import { book, poolSummary } from "./ledger.ts";
import { formatMoney, fromMinor, splitByWeights, toMinor } from "./money.ts";
import { edgeFor, moneyContext, recordMoneyEvent } from "./money/flow.ts";
import { PayPalError, runAsUser } from "./paypal/client.ts";
import {
  cancelPayoutItem,
  createPayoutBatch,
  getPayoutBatch,
  type CreatePayoutRequest,
  type PayoutItem,
} from "./paypal/payouts.ts";

export interface PolicyCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const days = (n: number) => n * 24 * 3600 * 1000;

/** What one payout item is expected to cost: the last fee PayPal reported in this currency, otherwise the configured estimate. */
export function feeEstimate(currency: string): { minor: number; source: "paypal" | "default" } {
  const reported = db()
    .prepare("SELECT fee_minor FROM payout_items WHERE currency = ? AND fee_minor > 0 ORDER BY COALESCE(status_changed_at, updated_at) DESC, rowid DESC LIMIT 1")
    .get(currency) as { fee_minor: number } | undefined;
  return reported ? { minor: reported.fee_minor, source: "paypal" } : { minor: toMinor(config.POLICY_PAYOUT_FEE_ESTIMATE, currency), source: "default" };
}

/** The smallest payout worth sending, in minor units: large enough that the fee stays within POLICY_MAX_FEE_SHARE, and within the min and max policy. */
export function payoutThreshold(currency: string, fee = feeEstimate(currency).minor): number {
  const forFeeShare = config.POLICY_MAX_FEE_SHARE > 0 ? Math.ceil(fee / config.POLICY_MAX_FEE_SHARE - 1e-9) : Number.POSITIVE_INFINITY;
  return Math.min(toMinor(config.POLICY_MAX_PAYOUT, currency), Math.max(toMinor(config.POLICY_MIN_PAYOUT, currency), forFeeShare));
}

function releaseExpiredReservations(currency: string, userId: string) {
  const at = now();
  const expired = db().prepare("SELECT COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE currency = ? AND user_id = ? AND status = 'reserved' AND expires_at IS NOT NULL AND expires_at < ?").get(currency, userId, at) as { t: number };
  db()
    .prepare("UPDATE allocations SET status = 'released', updated_at = ? WHERE currency = ? AND user_id = ? AND status = 'reserved' AND expires_at IS NOT NULL AND expires_at < ?")
    .run(at, currency, userId, at);
  if (Number(expired.t) > 0) {
    const edge = edgeFor({ type: "earmark", action: "release", amountMinor: Number(expired.t), currency });
    recordMoneyEvent({ userId, dedupeKey: `earmark:release:${userId}:${at.slice(0, 16)}`, type: "earmark", at, amountMinor: Number(expired.t), currency, trigger: { via: "none" }, ...edge! });
  }
}

export function discardDrafts(userId: string) {
  tx(() => {
    const drafts = db().prepare("SELECT id FROM settlements WHERE status = 'draft' AND user_id = ?").all(userId) as { id: string }[];
    for (const d of drafts) {
      db().prepare("DELETE FROM allocations WHERE settlement_id = ? AND status = 'planned'").run(d.id);
      db().prepare("DELETE FROM payout_items WHERE settlement_id = ?").run(d.id);
      db().prepare("DELETE FROM settlements WHERE id = ?").run(d.id);
    }
  });
}

/** Plans one person's payout from their own funds, sessions and held money. */
export function planSettlement(userId: string): { settlementId: string } {
  if (isCheckUser(userId)) throw new Error("A public check can't be paid out.");
  const currency = config.TITHE_CURRENCY;
  const open = db().prepare("SELECT id, status FROM settlements WHERE status IN ('approved','sending') AND user_id = ?").get(userId) as
    | { id: string; status: string }
    | undefined;
  if (open) throw new Error(`Settlement ${open.id} is ${open.status}; send or resolve it before planning another.`);
  discardDrafts(userId);
  releaseExpiredReservations(currency, userId);

  const pool = poolSummary(currency, userId);
  const feeRate = config.POLICY_PAYOUT_FEE_RESERVE;
  const fee = feeEstimate(currency);
  const threshold = payoutThreshold(currency, fee.minor);
  const maxPayout = toMinor(config.POLICY_MAX_PAYOUT, currency);
  // Every item sent is at least the threshold, so its fee is at most POLICY_MAX_FEE_SHARE of it. Keeping that much back means the per-item fee reserve always fits.
  const distributable = Math.floor(pool.available / (1 + Math.max(feeRate, config.POLICY_MAX_FEE_SHARE)));

  const sessions = db()
    .prepare("SELECT id FROM sessions WHERE status = 'attributed' AND allocated_settlement_id IS NULL AND user_id = ? ORDER BY started_at")
    .all(userId) as { id: string }[];
  const runs = sessions
    .map((s) => ({ session: s.id, run: activeRun(s.id) }))
    .filter((x): x is { session: string; run: NonNullable<ReturnType<typeof activeRun>> } => Boolean(x.run));

  // Each attributed session gets an equal slice of the pool; inside a slice, the validated weights decide.
  const shares = new Map<string, { ecosystem: string; name: string; share: number; sessions: Set<string> }>();
  let leftover = 0;
  for (const { session, run } of runs) {
    for (const w of run.validated.weights) {
      if (w.weight <= 0) continue;
      const k = `${w.ecosystem}:${w.name}`;
      const cur = shares.get(k) ?? { ecosystem: w.ecosystem, name: w.name, share: 0, sessions: new Set<string>() };
      cur.share += w.weight / runs.length;
      cur.sessions.add(session);
      shares.set(k, cur);
    }
    leftover += run.validated.unallocated / Math.max(runs.length, 1);
  }
  const entries = [...shares.values()];
  const amounts = splitByWeights(distributable, [...entries.map((e) => e.share), leftover]);

  const settlementId = newId("stl");
  const checks: PolicyCheck[] = [];
  const unpayable: { package: string; reason: string; amount_minor: number }[] = [];
  const heldForFees: { repo: string; held_minor: number; threshold_minor: number; fee_estimate_minor: number; fee_share_if_paid_now: number; estimate_source: "paypal" | "default" }[] = [];

  type RepoBucket = { repo: string; fresh: { e: (typeof entries)[number]; amount: number }[] };
  const byRepo = new Map<string, RepoBucket>();
  entries.forEach((e, i) => {
    const amount = amounts[i];
    if (amount <= 0) return;
    const pkg = db().prepare("SELECT repo FROM packages WHERE ecosystem = ? AND name = ?").get(e.ecosystem, e.name) as
      | { repo: string | null }
      | undefined;
    if (!pkg?.repo) {
      unpayable.push({ package: `${e.ecosystem}:${e.name}`, reason: "no source repository could be resolved", amount_minor: amount });
      return;
    }
    const b = byRepo.get(pkg.repo) ?? { repo: pkg.repo, fresh: [] };
    b.fresh.push({ e, amount });
    byRepo.set(pkg.repo, b);
  });

  const reservedRows = db()
    .prepare("SELECT * FROM allocations WHERE status = 'reserved' AND currency = ? AND user_id = ? ORDER BY created_at")
    .all(currency, userId) as any[];
  for (const r of reservedRows) if (r.repo && !byRepo.has(r.repo)) byRepo.set(r.repo, { repo: r.repo, fresh: [] });

  const items: {
    sender_item_id: string;
    claim_id: string;
    repo: string;
    receiver: string;
    amount: number;
    note: string;
    planned: string[];
    reservedIncluded: string[];
  }[] = [];
  const insertAlloc = db().prepare(
    `INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, expires_at, updated_at, user_id)
     VALUES (?,?,?,?,?,?,?,'planned',?,?,?,?,?,?)`,
  );
  const expires = new Date(Date.now() + days(config.POLICY_RESERVE_DAYS)).toISOString();

  tx(() => {
    for (const bucket of byRepo.values()) {
      const claim = payableClaim(bucket.repo);
      const reserved = reservedRows.filter((r) => r.repo === bucket.repo);
      if (!claim) {
        for (const f of bucket.fresh) {
          insertAlloc.run(newId("alc"), settlementId, bucket.repo, f.e.ecosystem, f.e.name, f.amount, currency, "reserve", JSON.stringify([...f.e.sessions]), now(), expires, now(), userId);
        }
        continue;
      }
      // Fill one payout item up to the per-item cap: older reservations first, then this run's share.
      let total = 0;
      const reservedIncluded: string[] = [];
      for (const r of reserved) {
        if (total + r.amount_minor > maxPayout) break;
        total += r.amount_minor;
        reservedIncluded.push(r.id);
      }
      const planned: string[] = [];
      const packages = new Set<string>(reserved.filter((r) => reservedIncluded.includes(r.id)).map((r) => r.package));
      for (const f of bucket.fresh) {
        const fit = Math.min(f.amount, Math.max(maxPayout - total, 0));
        const id = newId("alc");
        if (fit > 0) {
          insertAlloc.run(id, settlementId, bucket.repo, f.e.ecosystem, f.e.name, fit, currency, "payout", JSON.stringify([...f.e.sessions]), now(), null, now(), userId);
          planned.push(id);
          total += fit;
          packages.add(f.e.name);
        }
        if (fit < f.amount) {
          unpayable.push({ package: `${f.e.ecosystem}:${f.e.name}`, reason: `per-item cap ${config.POLICY_MAX_PAYOUT} ${currency} reached; excess stays in the pool`, amount_minor: f.amount - fit });
        }
      }
      if (total < threshold) {
        // Too small to send: hold it for this maintainer until it grows.
        for (const id of planned) db().prepare("UPDATE allocations SET target = 'reserve', expires_at = ? WHERE id = ?").run(expires, id);
        if (total > 0) heldForFees.push({ repo: bucket.repo, held_minor: total, threshold_minor: threshold, fee_estimate_minor: fee.minor, fee_share_if_paid_now: fee.minor / total, estimate_source: fee.source });
        continue;
      }
      if (total <= 0) continue;
      items.push({
        sender_item_id: `${settlementId}-${items.length + 1}`,
        claim_id: claim.id,
        repo: bucket.repo,
        receiver: claim.paypal_receiver!,
        amount: total,
        note: `${config.BRAND_NAME}: thanks for ${[...packages].slice(0, 4).join(", ")}${packages.size > 4 ? " and more" : ""} (${bucket.repo})`.slice(0, 4000),
        planned,
        reservedIncluded,
      });
    }

    const itemsTotal = items.reduce((a, i) => a + i.amount, 0);
    const feeReserve = items.reduce((a, i) => a + Math.max(Math.ceil(i.amount * feeRate), fee.minor), 0);
    const plannedReserve = (db().prepare("SELECT COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE settlement_id = ? AND target = 'reserve'").get(settlementId) as { t: number }).t;
    const newMoney = itemsTotal - items.reduce((a, i) => a + i.reservedIncluded.reduce((s, id) => s + (reservedRows.find((r) => r.id === id)?.amount_minor ?? 0), 0), 0);

    checks.push(
      { id: "pool", label: "Funds confirmed by PayPal", ok: pool.balance > 0, detail: `Pool balance ${fromMinor(pool.balance, currency)} ${currency}; available ${fromMinor(pool.available, currency)}.` },
      // Compared with the unclamped headroom: if PayPal's fees or a refund already left held money uncovered, even paying out held money must wait for funds.
      { id: "budget", label: "Within budget incl. fee reserve", ok: newMoney + Number(plannedReserve) + feeReserve <= pool.headroom, detail: pool.headroom < 0 ? `Held and in-flight money exceeds the PayPal-confirmed balance by ${fromMinor(-pool.headroom, currency)}; add funds before paying out.` : `New allocations ${fromMinor(newMoney + Number(plannedReserve), currency)} + fee reserve ${fromMinor(feeReserve, currency)} ≤ available ${fromMinor(pool.headroom, currency)}.` },
      { id: "receivers", label: "Every receiver is a verified maintainer", ok: items.every((i) => payableClaim(i.repo)?.id === i.claim_id), detail: `${items.length} item(s), each tied to a verified claim.` },
      { id: "item_cap", label: `Each item ≤ ${config.POLICY_MAX_PAYOUT} ${currency}`, ok: items.every((i) => i.amount <= maxPayout), detail: "Per-item maximum enforced in code." },
      {
        id: "item_min",
        label: `Each item ≥ ${formatMoney(threshold, currency)}, so PayPal's fee stays ≤ ${(config.POLICY_MAX_FEE_SHARE * 100).toFixed(0)}%`,
        ok: items.every((i) => i.amount >= threshold),
        detail: `PayPal's fee per item: ${formatMoney(fee.minor, currency)} (${fee.source === "paypal" ? "the last fee PayPal reported" : "the default, until PayPal reports one"}). Smaller amounts carry over for that maintainer.`,
      },
      {
        id: "evidence",
        label: "Every paid package cites session evidence",
        ok: runs.every((r) => r.run.validated.weights.every((w) => w.weight === 0 || w.evidence_ids.length > 0)),
        detail: `${runs.length} session(s); the validator already zeroed hallucinated and uncorroborated packages.`,
      },
      { id: "idempotency", label: "Idempotent batch id", ok: true, detail: `sender_batch_id upstream-${settlementId}; PayPal rejects reuse within 30 days.` },
    );

    db()
      .prepare(
        `INSERT INTO settlements(id, status, currency, pool_minor, planned_minor, reserved_minor, fee_reserve_minor, sender_batch_id, policy_json, created_at, user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        settlementId,
        items.length || Number(plannedReserve) ? "draft" : "empty",
        currency,
        pool.available,
        itemsTotal,
        Number(plannedReserve),
        feeReserve,
        `upstream-${settlementId}`,
        JSON.stringify({
          checks,
          sessions: runs.map((r) => r.session),
          unpayable,
          held_for_fees: heldForFees,
          leftover_share: leftover,
          distributable_minor: distributable,
          params: {
            max_package_share: config.POLICY_MAX_PACKAGE_SHARE,
            min_payout: config.POLICY_MIN_PAYOUT,
            payout_threshold: fromMinor(threshold, currency),
            max_payout: config.POLICY_MAX_PAYOUT,
            fee_reserve: feeRate,
            max_fee_share: config.POLICY_MAX_FEE_SHARE,
            fee_estimate: fromMinor(fee.minor, currency),
            fee_estimate_source: fee.source,
            reserve_days: config.POLICY_RESERVE_DAYS,
          },
        }),
        now(),
        userId,
      );
    const insItem = db().prepare(
      `INSERT INTO payout_items(sender_item_id, settlement_id, claim_id, repo, receiver, amount_minor, currency, note, allocation_ids_json, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const i of items) {
      insItem.run(i.sender_item_id, settlementId, i.claim_id, i.repo, i.receiver, i.amount, currency, i.note, JSON.stringify({ planned: i.planned, reserved: i.reservedIncluded }), now());
    }
  });
  return { settlementId };
}

function buildRequest(settlementId: string): CreatePayoutRequest {
  const s = db().prepare("SELECT * FROM settlements WHERE id = ?").get(settlementId) as any;
  const items = db().prepare("SELECT * FROM payout_items WHERE settlement_id = ? ORDER BY sender_item_id").all(settlementId) as any[];
  return {
    sender_batch_header: {
      sender_batch_id: s.sender_batch_id,
      email_subject: config.PAYOUT_EMAIL_SUBJECT,
      recipient_type: "EMAIL",
    },
    items: items.map((i) => ({
      recipient_type: "EMAIL" as const,
      amount: { currency: i.currency, value: fromMinor(i.amount_minor, i.currency) },
      receiver: i.receiver,
      note: i.note,
      sender_item_id: i.sender_item_id,
      ...(config.PAYOUT_PURPOSE ? { purpose: config.PAYOUT_PURPOSE } : {}),
    })),
  };
}

export function approveSettlement(settlementId: string) {
  tx(() => {
    const s = db().prepare("SELECT * FROM settlements WHERE id = ?").get(settlementId) as any;
    if (!s) throw new Error("Unknown settlement");
    if (s.status !== "draft") throw new Error(`Settlement is ${s.status}, not draft.`);
    const policy = json<{ checks: PolicyCheck[]; sessions: string[] }>(s.policy_json, { checks: [], sessions: [] });
    const failed = policy.checks.filter((c) => !c.ok);
    if (failed.length) throw new Error(`Policy checks failed: ${failed.map((c) => c.label).join(", ")}`);
    // Re-check funds at approval time; money may have moved since planning.
    const pool = poolSummary(s.currency, s.user_id);
    const reservedIncludedTotal = (db().prepare("SELECT allocation_ids_json FROM payout_items WHERE settlement_id = ?").all(settlementId) as any[])
      .flatMap((r) => json<{ reserved: string[] }>(r.allocation_ids_json, { reserved: [] }).reserved)
      .reduce((a, id) => a + Number((db().prepare("SELECT amount_minor FROM allocations WHERE id = ?").get(id) as any)?.amount_minor ?? 0), 0);
    const needed = s.planned_minor - reservedIncludedTotal + s.reserved_minor + s.fee_reserve_minor;
    if (needed > pool.headroom) {
      throw new Error(
        pool.headroom < 0
          ? `Held and in-flight money exceeds the PayPal-confirmed balance by ${fromMinor(-pool.headroom, s.currency)} (PayPal's fees or a refund). Add funds, then re-plan.`
          : `Pool changed: need ${fromMinor(needed, s.currency)}, available ${fromMinor(pool.headroom, s.currency)}. Re-plan.`,
      );
    }

    db().prepare("UPDATE allocations SET status = CASE target WHEN 'payout' THEN 'in_batch' ELSE 'reserved' END, updated_at = ? WHERE settlement_id = ? AND status = 'planned'").run(now(), settlementId);
    for (const it of db().prepare("SELECT sender_item_id, allocation_ids_json FROM payout_items WHERE settlement_id = ?").all(settlementId) as any[]) {
      const ids = json<{ planned: string[]; reserved: string[] }>(it.allocation_ids_json, { planned: [], reserved: [] });
      for (const id of [...ids.planned, ...ids.reserved]) {
        db().prepare("UPDATE allocations SET status = 'in_batch', payout_item_ref = ?, updated_at = ? WHERE id = ?").run(it.sender_item_id, now(), id);
      }
    }
    for (const sid of policy.sessions) db().prepare("UPDATE sessions SET allocated_settlement_id = ? WHERE id = ?").run(settlementId, sid);
    const hasItems = (db().prepare("SELECT COUNT(*) AS n FROM payout_items WHERE settlement_id = ?").get(settlementId) as any).n > 0;
    // A run with nothing payable only earmarks money for unclaimed repos: it is "held", never "sent", since PayPal is not called.
    db()
      .prepare("UPDATE settlements SET status = ?, approved_at = ?, request_json = ? WHERE id = ?")
      .run(hasItems ? "approved" : "held", now(), hasItems ? JSON.stringify(buildRequest(settlementId)) : null, settlementId);
    if (s.reserved_minor > 0) recordEarmark(settlementId, s.reserved_minor, s.currency, s.user_id, now(), false);
  });
}

/** Money set aside by an approved run. Only a line in Upstream's own records: PayPal isn't involved. */
export function recordEarmark(settlementId: string, amountMinor: number, currency: string, userId: string, at: string, backfilled: boolean) {
  const repos = (db().prepare("SELECT DISTINCT repo FROM allocations WHERE settlement_id = ? AND target = 'reserve' AND repo IS NOT NULL").all(settlementId) as { repo: string }[]).map((r) => r.repo);
  const edge = edgeFor({ type: "earmark", action: "approve", amountMinor, currency, repos, forFees: repos.length === 1 && Boolean(payableClaim(repos[0])) });
  recordMoneyEvent({ userId, dedupeKey: `earmark:approve:${settlementId}`, type: "earmark", at, amountMinor, currency, settlementId, repo: repos.length === 1 ? repos[0] : null, trigger: { via: "none" }, backfilled, ...edge! });
}

/** PayPal accepted this batch, so the money is now on PayPal's side. */
function recordBatchAccepted(settlementId: string, payoutBatchId: string, currency: string, userId: string) {
  const items = db().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS t FROM payout_items WHERE settlement_id = ?").get(settlementId) as { n: number; t: number };
  const edge = edgeFor({ type: "batch", amountMinor: Number(items.t), currency, batchId: payoutBatchId, payments: Number(items.n) });
  recordMoneyEvent({ userId, dedupeKey: `batch:${settlementId}`, type: "batch", at: now(), amountMinor: Number(items.t), currency, settlementId, paypalIds: { payout_batch_id: payoutBatchId }, trigger: moneyContext.getStore() ?? { via: "api", action: "send payout batch" }, ...edge! });
}

/** Locally idempotent; PayPal-side idempotency comes from sender_batch_id + PayPal-Request-Id. */
export async function executeSettlement(settlementId: string) {
  const s = db().prepare("SELECT * FROM settlements WHERE id = ?").get(settlementId) as any;
  if (!s) throw new Error("Unknown settlement");
  if (s.status === "sent") return { alreadySent: true, payout_batch_id: s.payout_batch_id as string | null };
  if (s.status !== "approved" && s.status !== "sending") throw new Error(`Settlement is ${s.status}; approve it first.`);
  db().prepare("UPDATE settlements SET status = 'sending' WHERE id = ?").run(settlementId);
  const request = json<CreatePayoutRequest>(s.request_json, buildRequest(settlementId));
  try {
    const res = await createPayoutBatch(request, s.sender_batch_id);
    const h = res.data.batch_header;
    db()
      .prepare("UPDATE settlements SET status = 'sent', payout_batch_id = ?, batch_status = ?, sent_at = ?, error_json = NULL WHERE id = ?")
      .run(h.payout_batch_id, h.batch_status, now(), settlementId);
    recordBatchAccepted(settlementId, h.payout_batch_id, s.currency, s.user_id);
    return { alreadySent: false, payout_batch_id: h.payout_batch_id, batch_status: h.batch_status, debug_id: res.debugId };
  } catch (err) {
    if (err instanceof PayPalError && err.status < 500) {
      // A duplicate sender_batch_id error links to the original batch: that means an earlier attempt landed.
      const href = ((err.body as any)?.links ?? []).map((l: any) => l.href as string).find((h: string) => /\/v1\/payments\/payouts\/[^/?]+/.test(h));
      const original = href?.match(/\/v1\/payments\/payouts\/([^/?]+)/)?.[1];
      if (original) {
        db().prepare("UPDATE settlements SET status = 'sent', payout_batch_id = ?, sent_at = COALESCE(sent_at, ?), error_json = ? WHERE id = ?").run(original, now(), JSON.stringify({ recovered_from: err.body }), settlementId);
        recordBatchAccepted(settlementId, original, s.currency, s.user_id);
        return { alreadySent: true, payout_batch_id: original, recovered: true };
      }
      tx(() => {
        db().prepare("UPDATE settlements SET status = 'failed', error_json = ? WHERE id = ?").run(JSON.stringify({ status: err.status, body: err.body, debug_id: err.debugId }), settlementId);
        db().prepare("UPDATE allocations SET status = 'reserved', payout_item_ref = NULL, updated_at = ? WHERE status = 'in_batch' AND payout_item_ref IN (SELECT sender_item_id FROM payout_items WHERE settlement_id = ?)").run(now(), settlementId);
      });
    } else {
      db().prepare("UPDATE settlements SET error_json = ? WHERE id = ?").run(JSON.stringify({ retryable: true, message: String(err) }), settlementId);
    }
    throw err;
  }
}

/** Re-send the stored request with a new PayPal-Request-Id so only sender_batch_id dedupe applies. */
export async function replaySettlement(settlementId: string) {
  const s = db().prepare("SELECT * FROM settlements WHERE id = ?").get(settlementId) as any;
  if (!s || s.status !== "sent" || !s.request_json) throw new Error("Only a sent settlement can be replayed.");
  if (Date.now() - new Date(s.sent_at).getTime() > days(29)) {
    throw new Error("PayPal only guarantees sender_batch_id dedupe within 30 days; replay is disabled after 29.");
  }
  try {
    const res = await createPayoutBatch(JSON.parse(s.request_json), `replay-${crypto.randomUUID()}`);
    return { rejected: false, status: res.status, body: res.data, debug_id: res.debugId };
  } catch (err) {
    if (err instanceof PayPalError) return { rejected: true, status: err.status, body: err.body, debug_id: err.debugId };
    throw err;
  }
}

const SENT_STATES = new Set(["SUCCESS", "UNCLAIMED", "ONHOLD", "RETURNED", "REFUNDED", "REVERSED"]);
const RETURN_STATES = new Set(["RETURNED", "REFUNDED", "REVERSED"]);

/** Apply one PayPal payout item (from a webhook or a GET) to our records and the ledger. */
export function applyPayoutItem(item: PayoutItem, source: "webhook" | "api_sync", eventType?: string) {
  const senderItemId = item.payout_item?.sender_item_id;
  const row = db()
    .prepare("SELECT * FROM payout_items WHERE payout_item_id = ? OR sender_item_id = ?")
    .get(item.payout_item_id, senderItemId ?? "") as any;
  if (!row) return { matched: false };
  const userId = (db().prepare("SELECT user_id FROM settlements WHERE id = ?").get(row.settlement_id) as { user_id: string }).user_id;
  const status = eventType === "PAYMENT.PAYOUTS-ITEM.CANCELED" && item.transaction_status === "UNCLAIMED" ? "RETURNED" : item.transaction_status;
  const fee = item.payout_item_fee ? toMinor(item.payout_item_fee.value, item.payout_item_fee.currency) : null;
  tx(() => {
    db()
      .prepare(
        `UPDATE payout_items SET payout_item_id = ?, transaction_id = COALESCE(?, transaction_id), transaction_status = ?,
           fee_minor = COALESCE(?, fee_minor), errors_json = ?, updated_at = ?,
           status_changed_at = CASE WHEN COALESCE(transaction_status,'') != ? THEN ? ELSE status_changed_at END
         WHERE sender_item_id = ?`,
      )
      .run(item.payout_item_id, item.transaction_id ?? null, status ?? null, fee, item.errors ? JSON.stringify(item.errors) : null, now(), status ?? "", now(), row.sender_item_id);

    // Before the fee is booked, so the event list reads in the order things happened: paid, then PayPal's fee.
    if (status && status !== row.transaction_status) {
      const edge = edgeFor({ type: "payout_status", status, previous: row.transaction_status, amountMinor: row.amount_minor, currency: row.currency, repo: row.repo });
      recordMoneyEvent({
        userId,
        dedupeKey: `payout:${row.sender_item_id}:${status}`,
        type: "payout_status",
        at: item.time_processed ?? now(),
        amountMinor: row.amount_minor,
        currency: row.currency,
        refType: "payout_item",
        refId: row.sender_item_id,
        settlementId: row.settlement_id,
        repo: row.repo,
        statusFrom: row.transaction_status,
        statusTo: status,
        paypalIds: { payout_item_id: item.payout_item_id, transaction_id: item.transaction_id, payout_batch_id: item.payout_batch_id },
        ...edge!,
      });
    }

    if (status && SENT_STATES.has(status)) {
      book({ dedupeKey: `sent:${row.sender_item_id}`, kind: "PAYOUT_SENT", amountMinor: -row.amount_minor, currency: row.currency, refType: "payout_item", refId: row.sender_item_id, memo: `Payout to ${row.repo}`, source, userId });
      if (fee && fee > 0) {
        book({ dedupeKey: `fee:${row.sender_item_id}`, kind: "PAYOUT_FEE", amountMinor: -fee, currency: row.currency, refType: "payout_item", refId: row.sender_item_id, memo: `PayPal payout fee (reported by PayPal)`, source, userId });
      }
      db().prepare("UPDATE allocations SET status = 'paid', updated_at = ? WHERE payout_item_ref = ? AND status = 'in_batch'").run(now(), row.sender_item_id);
    }
    const reEarmark = () =>
      db()
        .prepare("UPDATE allocations SET status = 'reserved', payout_item_ref = NULL, expires_at = ?, updated_at = ? WHERE payout_item_ref = ? AND status IN ('in_batch','paid')")
        .run(new Date(Date.now() + days(config.POLICY_RESERVE_DAYS)).toISOString(), now(), row.sender_item_id);
    if (status && RETURN_STATES.has(status)) {
      book({ dedupeKey: `returned:${row.sender_item_id}`, kind: "PAYOUT_RETURNED", amountMinor: row.amount_minor, currency: row.currency, refType: "payout_item", refId: row.sender_item_id, memo: `Returned by PayPal (${status})`, source, userId });
      reEarmark();
      markReceiverUnclaimed(row.claim_id);
    }
    if (status === "FAILED" || status === "BLOCKED") {
      reEarmark();
      if (status === "FAILED") markReceiverUnclaimed(row.claim_id);
    }
  });
  return { matched: true, status };
}

export async function syncSettlement(settlementId: string) {
  const s = db().prepare("SELECT * FROM settlements WHERE id = ?").get(settlementId) as any;
  if (!s?.payout_batch_id) throw new Error("This settlement has no PayPal batch yet.");
  const { header, items } = await runAsUser(s.user_id as string, () => getPayoutBatch(s.payout_batch_id));
  db()
    .prepare("UPDATE settlements SET batch_status = ?, batch_fee_minor = ?, synced_at = ? WHERE id = ?")
    .run(header.batch_status, header.fees ? toMinor(header.fees.value, header.fees.currency) : null, now(), settlementId);
  let matched = 0;
  for (const it of items) if (applyPayoutItem(it, "api_sync").matched) matched++;
  return { batch_status: header.batch_status, items: items.length, matched };
}

export async function cancelUnclaimed(senderItemId: string, opts: { manual: boolean }) {
  const row = db().prepare("SELECT * FROM payout_items WHERE sender_item_id = ?").get(senderItemId) as any;
  if (!row?.payout_item_id) throw new Error("Unknown payout item.");
  if (row.transaction_status !== "UNCLAIMED") throw new Error(`Only UNCLAIMED items can be cancelled (this one is ${row.transaction_status}).`);
  const age = Date.now() - new Date(row.status_changed_at ?? row.updated_at).getTime();
  if (!opts.manual && age < days(config.POLICY_CANCEL_UNCLAIMED_AFTER_DAYS)) {
    throw new Error(`Policy waits ${config.POLICY_CANCEL_UNCLAIMED_AFTER_DAYS} days before cancelling.`);
  }
  const owner = (db().prepare("SELECT user_id FROM settlements WHERE id = ?").get(row.settlement_id) as { user_id: string }).user_id;
  const res = await runAsUser(owner, () => cancelPayoutItem(row.payout_item_id));
  applyPayoutItem(res.data, "api_sync", "PAYMENT.PAYOUTS-ITEM.CANCELED");
  return res.data;
}

/** Runs on an interval: sync open batches, cancel stale UNCLAIMED items per policy. */
export function housekeeping() {
  return moneyContext.run({ via: "api", action: "scheduled sync" }, runHousekeeping);
}

async function runHousekeeping() {
  cleanupExpiredChecks();
  const open = db()
    .prepare(
      `SELECT id FROM settlements WHERE status = 'sent' AND payout_batch_id IS NOT NULL AND (COALESCE(batch_status,'') NOT IN ('SUCCESS','DENIED','CANCELED')
         OR id IN (SELECT settlement_id FROM payout_items WHERE transaction_status IN ('UNCLAIMED','PENDING','ONHOLD')))`,
    )
    .all() as { id: string }[];
  const out: Record<string, unknown> = {};
  for (const s of open) {
    try {
      out[s.id] = await syncSettlement(s.id);
    } catch (e) {
      out[s.id] = { error: String(e) };
    }
  }
  // Funding is re-read from PayPal too, so payments and refunds are booked even if a webhook never arrives.
  Object.assign(out, await syncKnownSubscriptions());
  Object.assign(out, await syncOpenTopups());
  const stale = db()
    .prepare("SELECT sender_item_id FROM payout_items WHERE transaction_status = 'UNCLAIMED' AND status_changed_at < ?")
    .all(new Date(Date.now() - days(config.POLICY_CANCEL_UNCLAIMED_AFTER_DAYS)).toISOString()) as { sender_item_id: string }[];
  for (const it of stale) {
    try {
      await cancelUnclaimed(it.sender_item_id, { manual: false });
      out[`cancel:${it.sender_item_id}`] = "cancelled";
    } catch (e) {
      out[`cancel:${it.sender_item_id}`] = String(e);
    }
  }
  return out;
}
