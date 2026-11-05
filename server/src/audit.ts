// Self-audit: re-checks the stored records against the rules the money follows, so the dashboard can show
// what holds right now instead of asserting it. Every check reads the database; nothing here is hard-coded.
// A check with nothing to examine reports "empty", never "pass".
import { config, features } from "./config.ts";
import { db, json, now } from "./db.ts";
import { poolSummary } from "./ledger.ts";
import { activeRun } from "./attribution/run.ts";
import { fromMinor } from "./money.ts";

export interface AuditCheck {
  id: string;
  label: string;
  why: string;
  status: "pass" | "fail" | "empty";
  checked: number;
  detail: string;
  failures: string[];
}

const SENT_STATES = new Set(["SUCCESS", "UNCLAIMED", "ONHOLD", "RETURNED", "REFUNDED", "REVERSED"]);
const RETURN_STATES = new Set(["RETURNED", "REFUNDED", "REVERSED"]);
const MAX_LISTED = 10;

function check(id: string, label: string, why: string, checked: number, failures: string[], detail: string): AuditCheck {
  return {
    id,
    label,
    why,
    status: checked === 0 ? "empty" : failures.length ? "fail" : "pass",
    checked,
    detail,
    failures: failures.slice(0, MAX_LISTED),
  };
}

const rows = <T>(sql: string, ...args: (string | number | null)[]) => db().prepare(sql).all(...args) as T[];

function ledgerTraces(userId: string): AuditCheck {
  const entries = rows<{ id: number; kind: string; ref_type: string | null; ref_id: string | null }>("SELECT id, kind, ref_type, ref_id FROM ledger WHERE user_id = ?", userId);
  const failures: string[] = [];
  for (const e of entries) {
    const has = (sql: string) => Boolean(db().prepare(sql).get(e.ref_id ?? "", userId));
    const ok =
      e.kind.startsWith("FUNDING_")
        ? e.ref_type === "subscription"
          ? has("SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ?")
          : e.ref_type === "topup" && has("SELECT 1 FROM topups WHERE id = ? AND user_id = ? AND capture_id IS NOT NULL")
        : e.ref_type === "payout_item" && has("SELECT 1 FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE p.sender_item_id = ? AND s.user_id = ? AND p.payout_item_id IS NOT NULL");
    if (!ok) failures.push(`ledger #${e.id} ${e.kind} → ${e.ref_type ?? "?"} ${e.ref_id ?? "?"} has no matching PayPal record`);
  }
  return check(
    "ledger_traces_to_paypal",
    "Every ledger entry points at a PayPal object",
    "Money is only booked from PayPal's own records: a subscription transaction, a captured order, or a payout item PayPal gave an id.",
    entries.length,
    failures,
    `${entries.length} entries checked against subscriptions, captured top-ups and PayPal payout items.`,
  );
}

function poolCovered(userId: string): AuditCheck {
  const cur = config.TITHE_CURRENCY;
  const p = poolSummary(cur, userId);
  const touched = Number((db().prepare("SELECT (SELECT COUNT(*) FROM ledger WHERE user_id = ?) + (SELECT COUNT(*) FROM allocations WHERE user_id = ? AND status IN ('reserved','in_batch')) AS n").get(userId, userId) as { n: number }).n);
  const committed = p.reserved + p.inFlight;
  const failures = committed > p.balance ? [`held ${fromMinor(p.reserved, cur)} + in flight ${fromMinor(p.inFlight, cur)} exceeds the PayPal-confirmed balance ${fromMinor(p.balance, cur)}`] : [];
  return check(
    "pool_not_overcommitted",
    "Held and in-flight money is covered by confirmed funds",
    "Nothing is earmarked or sent that PayPal hasn't confirmed arrived.",
    touched ? 1 : 0,
    failures,
    `Balance ${fromMinor(p.balance, cur)} ${cur}; held ${fromMinor(p.reserved, cur)}; in flight ${fromMinor(p.inFlight, cur)}.`,
  );
}

type Item = { sender_item_id: string; settlement_id: string; claim_id: string; repo: string; amount_minor: number; currency: string; transaction_status: string | null; fee_minor: number | null; payout_item_id: string | null; s_status: string; approved_at: string | null; policy_json: string };
const items = (userId: string) =>
  rows<Item>(
    `SELECT p.*, s.status AS s_status, s.approved_at, s.policy_json FROM payout_items p JOIN settlements s ON s.id = p.settlement_id
     WHERE s.user_id = ? AND s.status NOT IN ('draft','failed')`,
    userId,
  );

function receiversVerified(list: Item[]): AuditCheck {
  const failures: string[] = [];
  for (const i of list) {
    const c = db().prepare("SELECT method, verified_at, evidence_json FROM claims WHERE id = ?").get(i.claim_id) as
      | { method: string; verified_at: string | null; evidence_json: string | null }
      | undefined;
    if (!c) failures.push(`${i.sender_item_id}: claim ${i.claim_id} does not exist`);
    else if (!c.verified_at || !i.approved_at || c.verified_at > i.approved_at) failures.push(`${i.sender_item_id}: claim for ${i.repo} was not verified before the run was approved`);
    else if (!Object.keys(json(c.evidence_json, {})).length) failures.push(`${i.sender_item_id}: claim for ${i.repo} has no stored proof`);
  }
  return check(
    "payouts_to_verified_maintainers",
    "Every payout went to a maintainer verified before approval",
    "Proof is GitHub admin/maintain permission or a token found in the repo's FUNDING.yml, stored with the claim.",
    list.length,
    failures,
    `${list.length} approved payout item(s) checked against their claims.`,
  );
}

function itemsMatchAllocations(list: Item[]): AuditCheck {
  const failures: string[] = [];
  const live = list.filter((i) => !RETURN_STATES.has(i.transaction_status ?? "") && i.transaction_status !== "FAILED" && i.transaction_status !== "BLOCKED");
  for (const i of live) {
    const sum = Number((db().prepare("SELECT COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE payout_item_ref = ?").get(i.sender_item_id) as { t: number }).t);
    if (sum !== i.amount_minor) failures.push(`${i.sender_item_id}: item ${fromMinor(i.amount_minor, i.currency)} but its allocations add up to ${fromMinor(sum, i.currency)}`);
  }
  return check(
    "items_equal_allocations",
    "Each payout item equals the allocations behind it",
    "No money is sent that isn't traced to a package share, to the cent.",
    live.length,
    failures,
    `${live.length} live payout item(s) summed against their allocations.`,
  );
}

function ledgerMatchesPayPal(list: Item[]): AuditCheck {
  const failures: string[] = [];
  const entry = (kind: string, ref: string) =>
    rows<{ amount_minor: number }>("SELECT amount_minor FROM ledger WHERE kind = ? AND ref_type = 'payout_item' AND ref_id = ?", kind, ref);
  for (const i of list) {
    const st = i.transaction_status ?? "";
    const sent = entry("PAYOUT_SENT", i.sender_item_id);
    if (SENT_STATES.has(st)) {
      if (sent.length !== 1 || sent[0].amount_minor !== -i.amount_minor) failures.push(`${i.sender_item_id}: PayPal says ${st} but the ledger has ${sent.length} matching send entr${sent.length === 1 ? "y" : "ies"}`);
      if (i.fee_minor && i.fee_minor > 0) {
        const fee = entry("PAYOUT_FEE", i.sender_item_id);
        if (fee.length !== 1 || fee[0].amount_minor !== -i.fee_minor) failures.push(`${i.sender_item_id}: PayPal's fee ${fromMinor(i.fee_minor, i.currency)} is not booked exactly once`);
      }
    } else if (sent.length) {
      failures.push(`${i.sender_item_id}: booked as sent although PayPal reports ${st || "no status"}`);
    }
    if (RETURN_STATES.has(st)) {
      const back = entry("PAYOUT_RETURNED", i.sender_item_id);
      if (back.length !== 1 || back[0].amount_minor !== i.amount_minor) failures.push(`${i.sender_item_id}: PayPal says ${st} but the return is not booked exactly once`);
    }
  }
  return check(
    "ledger_matches_payout_status",
    "The ledger agrees with each payout's PayPal status",
    "Sent, fee and returned entries exist exactly once for what PayPal reported, and never for items PayPal hasn't sent.",
    list.length,
    failures,
    `${list.length} payout item(s) compared with their ledger entries.`,
  );
}

function capsRespected(list: Item[]): AuditCheck {
  const failures: string[] = [];
  for (const i of list) {
    const params = json<{ params?: { min_payout?: string; max_payout?: string } }>(i.policy_json, {}).params ?? {};
    const v = Number(fromMinor(i.amount_minor, i.currency));
    if (params.max_payout && v > Number(params.max_payout)) failures.push(`${i.sender_item_id}: ${v} is above the cap ${params.max_payout} in force when planned`);
    if (params.min_payout && v < Number(params.min_payout)) failures.push(`${i.sender_item_id}: ${v} is below the minimum ${params.min_payout} in force when planned`);
  }
  return check(
    "payout_caps_respected",
    "Every payout item is within the caps in force when it was planned",
    "POLICY_MIN_PAYOUT and POLICY_MAX_PAYOUT are recorded with each run and enforced in code.",
    list.length,
    failures,
    `${list.length} payout item(s) checked against their run's recorded policy.`,
  );
}

function webhooksVerified(): AuditCheck {
  const processed = rows<{ id: string; event_type: string; verification_status: string }>(
    "SELECT id, event_type, verification_status FROM webhook_events WHERE processed_at IS NOT NULL",
  );
  const failures = processed.filter((w) => w.verification_status !== "SUCCESS").map((w) => `${w.event_type} ${w.id} was processed with verification ${w.verification_status}`);
  return check(
    "webhooks_signature_verified",
    "Only PayPal-verified webhooks changed anything",
    "Each event is checked with PayPal's verify-webhook-signature API before it is acted on; unverified ones are only stored.",
    processed.length,
    failures,
    `${processed.length} processed webhook(s) checked.`,
  );
}

function weightsCiteEvidence(userId: string): AuditCheck {
  const sessions = rows<{ id: string }>("SELECT id FROM sessions WHERE status = 'attributed' AND user_id = ?", userId);
  const failures: string[] = [];
  let checked = 0;
  for (const s of sessions) {
    const run = activeRun(s.id);
    if (!run) continue;
    const stored = new Set(rows<{ id: string }>("SELECT id FROM evidence WHERE session_id = ?", s.id).map((r) => r.id));
    const total = run.validated.weights.reduce((a, w) => a + w.weight, 0) + run.validated.unallocated;
    if (Math.abs(total - 1) > 1e-3) failures.push(`${s.id}: weights plus the unallocated share add up to ${total.toFixed(4)}, not 1`);
    for (const w of run.validated.weights.filter((x) => x.weight > 0)) {
      checked++;
      const key = `${w.ecosystem}:${w.name}`;
      const cand = run.candidates.candidates?.find((c) => c.ecosystem === w.ecosystem && c.name === w.name);
      if (!cand) failures.push(`${s.id}: ${key} is paid but is not a candidate of the session`);
      else if (!w.evidence_ids.length) failures.push(`${s.id}: ${key} is paid without citing evidence`);
      else {
        const bad = w.evidence_ids.filter((id) => !stored.has(id) || !cand.evidence_ids.includes(id));
        if (bad.length) failures.push(`${s.id}: ${key} cites ${bad.join(", ")}, which is not recorded evidence linked to it`);
      }
    }
  }
  return check(
    "paid_weights_cite_evidence",
    "Every paid share cites evidence the hook recorded",
    "Re-checked against the evidence table, not the model's output: no share rests on a package or evidence id the session doesn't have.",
    checked,
    failures,
    `${checked} paid share(s) in ${sessions.length} attributed session(s) checked.`,
  );
}

function allocationsTrace(userId: string): AuditCheck {
  const allocs = rows<{ id: string; settlement_id: string; ecosystem: string; package: string; session_ids_json: string }>(
    "SELECT id, settlement_id, ecosystem, package, session_ids_json FROM allocations WHERE user_id = ? AND status != 'planned'",
    userId,
  );
  const failures: string[] = [];
  for (const a of allocs) {
    const ids = json<string[]>(a.session_ids_json, []);
    if (!ids.length) {
      failures.push(`${a.id}: no session behind ${a.ecosystem}:${a.package}`);
      continue;
    }
    for (const sid of ids) {
      const s = db().prepare("SELECT allocated_settlement_id FROM sessions WHERE id = ?").get(sid) as { allocated_settlement_id: string | null } | undefined;
      const w = activeRun(sid)?.validated.weights.find((x) => x.ecosystem === a.ecosystem && x.name === a.package);
      if (!s) failures.push(`${a.id}: session ${sid} does not exist`);
      else if (s.allocated_settlement_id !== a.settlement_id) failures.push(`${a.id}: session ${sid} is not locked to the run that allocated it`);
      else if (!w || w.weight <= 0) failures.push(`${a.id}: session ${sid}'s attribution gives ${a.ecosystem}:${a.package} no share`);
    }
  }
  return check(
    "allocations_trace_to_sessions",
    "Every allocation traces to sessions that gave the package a share",
    "Each earmark lists its sessions; those sessions are locked to the run and their attribution still pays that package.",
    allocs.length,
    failures,
    `${allocs.length} allocation(s) traced.`,
  );
}

function reconciliationFresh(userId: string): AuditCheck {
  const open = rows<{ id: string; synced_at: string | null }>(
    `SELECT id, synced_at FROM settlements WHERE user_id = ? AND status = 'sent' AND payout_batch_id IS NOT NULL AND (COALESCE(batch_status,'') NOT IN ('SUCCESS','DENIED','CANCELED')
       OR id IN (SELECT settlement_id FROM payout_items WHERE transaction_status IN ('UNCLAIMED','PENDING','ONHOLD')))`,
    userId,
  );
  const limit = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const failures = open
    .filter((s) => !s.synced_at || s.synced_at < limit)
    .map((s) => `${s.id}: last read from PayPal ${s.synced_at ?? "never"}${features.paypal ? "" : " (PayPal keys are missing on this server)"}`);
  return check(
    "open_batches_reconciled",
    "Open PayPal batches were re-read in the last 2 hours",
    "An hourly job re-reads every unfinished batch from PayPal, so statuses don't depend on webhooks arriving.",
    open.length,
    failures,
    `${open.length} unfinished batch(es).`,
  );
}

/** What has actually happened in this person's space, counted from its records. Webhook totals are server-wide and name nobody. */
function activity(userId: string) {
  const one = <T>(sql: string, ...args: string[]) => db().prepare(sql).get(...args) as T;
  const calls = one<{ total: number; ok: number; first: string | null; last: string | null }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok, MIN(at) AS first, MAX(at) AS last FROM paypal_calls WHERE user_id = ?",
    userId,
  );
  const flags = rows<{ flags_json: string }>("SELECT r.flags_json FROM attribution_runs r JOIN sessions s ON s.id = r.session_id WHERE r.method = 'llm' AND s.user_id = ?", userId).flatMap((r) => json<{ code: string }[]>(r.flags_json, []));
  const dropped = (code: string) => flags.filter((f) => f.code === code).length;
  return {
    paypal_calls: { total: Number(calls.total), succeeded: Number(calls.ok ?? 0), first_at: calls.first, last_at: calls.last },
    webhooks: one<{ received: number; verified: number }>(
      "SELECT COUNT(*) AS received, SUM(CASE WHEN verification_status = 'SUCCESS' THEN 1 ELSE 0 END) AS verified FROM webhook_events",
    ),
    llm_runs: Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM attribution_runs r JOIN sessions s ON s.id = r.session_id WHERE r.method = 'llm' AND s.user_id = ?", userId).n),
    models: rows<{ model: string }>("SELECT DISTINCT r.model FROM attribution_runs r JOIN sessions s ON s.id = r.session_id WHERE r.method = 'llm' AND r.model IS NOT NULL AND s.user_id = ?", userId).map((r) => r.model),
    validator: {
      hallucinated_packages: dropped("HALLUCINATED_PACKAGE"),
      unknown_evidence: dropped("CITED_UNKNOWN_EVIDENCE"),
      uncorroborated: dropped("UNCORROBORATED"),
    },
    payout_items_confirmed: Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE p.payout_item_id IS NOT NULL AND p.transaction_status IS NOT NULL AND s.user_id = ?", userId).n),
    ledger_entries: Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?", userId).n),
    hook_events: Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM hook_events h JOIN sessions s ON s.id = h.session_id WHERE s.user_id = ?", userId).n),
  };
}

export function auditReport(userId: string) {
  const list = items(userId);
  const checks = [
    ledgerTraces(userId),
    poolCovered(userId),
    receiversVerified(list),
    itemsMatchAllocations(list),
    ledgerMatchesPayPal(list),
    capsRespected(list),
    webhooksVerified(),
    weightsCiteEvidence(userId),
    allocationsTrace(userId),
    reconciliationFresh(userId),
  ];
  return {
    generated_at: now(),
    summary: {
      pass: checks.filter((c) => c.status === "pass").length,
      fail: checks.filter((c) => c.status === "fail").length,
      empty: checks.filter((c) => c.status === "empty").length,
    },
    checks,
    activity: activity(userId),
    environment: config.PAYPAL_ENV,
    features,
  };
}
