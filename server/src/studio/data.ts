// The data behind /insights, the AG Studio board: one viewer's sessions, package shares, allocations,
// payouts, maintainers, ledger and money events, each as a flat table.
//
// Scoping follows the rest of /api: everything is read for one user id. payout_items has no owner
// column, so it is read through its settlement's owner. Maintainer claims are shared across users,
// so only the repos this viewer's money touched are listed.
//
// Money stays in integer minor units until the moment a row is built here.
import { db } from "../db.ts";
import { config } from "../config.ts";
import { fromMinor } from "../money.ts";
import { runsForSession, type RunMethod } from "../attribution/run.ts";
import { manifestComparison } from "../attribution/manifest.ts";
import type { Validated } from "../attribution/validate.ts";
import type { Candidate } from "../evidence/candidates.ts";

/** Named the way people say it: "imports" is the import-count baseline, "manifest" the dependency-list split. */
export type ShareMethod = "llm" | "imports" | "manifest";
const METHOD: Record<RunMethod, ShareMethod> = { llm: "llm", baseline: "imports", manifest: "manifest" };

const major = (minor: number | null | undefined, currency: string) => (minor == null ? null : Number(fromMinor(Number(minor), currency)));
const all = <T>(sql: string, ...args: (string | number | null)[]) => db().prepare(sql).all(...args) as T[];

/** "github.com/owner/name" reads as "owner/name". */
export const repoLabel = (repo: string | null | undefined) => (repo ? repo.replace(/^https?:\/\//, "").replace(/^(www\.)?github\.com\//i, "") : null);

export interface ShareRow {
  session_id: string;
  ecosystem: string;
  package: string;
  method: ShareMethod;
  share: number;
  in_manifest: boolean;
  has_evidence: boolean;
  /** The session has both an Upstream review and a dependency list, so its two shares can be compared like for like. */
  comparable: boolean;
}

/**
 * One row per package and method for a session, from the newest run of each method (the same
 * choice the accuracy page makes). A package declared in the project file but given nothing by a
 * method still gets a row with share 0, so "declared but never used" is visible.
 *
 * Older sessions have no stored dependency-list run. Where the session's candidates record its
 * project file, the split comes from manifestComparison, the same function that makes those runs.
 */
export function sharesForSession(sessionId: string): ShareRow[] {
  const runs = runsForSession(sessionId); // newest first
  const latest = new Map<RunMethod, Validated>();
  for (const r of runs) if (!latest.has(r.method)) latest.set(r.method, r.validated);
  if (!latest.size) return [];
  if (!latest.has("manifest") && runs[0]?.candidates?.candidates) {
    const derived = manifestComparison(runs[0].candidates);
    if (derived) latest.set("manifest", derived);
  }
  const comparable = latest.has("llm") && latest.has("manifest");

  const candidates = new Map<string, Candidate>();
  for (const r of runs) for (const c of r.candidates?.candidates ?? []) {
    const k = `${c.ecosystem}:${c.name}`;
    if (!candidates.has(k)) candidates.set(k, c);
  }
  const declared = (c?: Candidate) => Boolean(c && (c.in_initial_manifest || c.in_final_manifest));

  const keys = new Set<string>();
  for (const [k, c] of candidates) if (declared(c)) keys.add(k);
  for (const v of latest.values()) for (const w of v.weights) if (w.weight > 0) keys.add(`${w.ecosystem}:${w.name}`);

  const rows: ShareRow[] = [];
  for (const [method, v] of latest) {
    const weights = new Map(v.weights.map((w) => [`${w.ecosystem}:${w.name}`, w.weight]));
    for (const k of keys) {
      const i = k.indexOf(":");
      const c = candidates.get(k);
      rows.push({
        session_id: sessionId,
        ecosystem: k.slice(0, i),
        package: k.slice(i + 1),
        method: METHOD[method],
        share: Math.round((weights.get(k) ?? 0) * 1e6) / 1e6,
        in_manifest: declared(c),
        has_evidence: (c?.evidence_ids?.length ?? 0) > 0,
        comparable,
      });
    }
  }
  return rows;
}

export function studioData(userId: string) {
  const currency = config.TITHE_CURRENCY;

  const sessionRows = all<{ id: string; project: string | null; started_at: string; ended_at: string | null; status: string }>(
    "SELECT id, project, started_at, ended_at, status FROM sessions WHERE user_id = ? ORDER BY started_at",
    userId,
  );
  const evidenceCounts = new Map(
    all<{ session_id: string; n: number }>(
      "SELECT e.session_id, COUNT(*) AS n FROM evidence e JOIN sessions s ON s.id = e.session_id WHERE s.user_id = ? GROUP BY e.session_id",
      userId,
    ).map((r) => [r.session_id, Number(r.n)]),
  );
  const shares: ShareRow[] = [];
  const sessions = sessionRows.map((s) => {
    const rows = sharesForSession(s.id);
    shares.push(...rows);
    return {
      id: s.id,
      project: s.project ?? "(unnamed project)",
      started_at: s.started_at,
      ended_at: s.ended_at,
      status: s.status,
      evidence_count: evidenceCounts.get(s.id) ?? 0,
      packages_used: rows.filter((r) => r.method === "llm" && r.share > 0).length,
    };
  });

  const allocations = all<any>(
    "SELECT id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, created_at, expires_at FROM allocations WHERE user_id = ? ORDER BY created_at",
    userId,
  ).map((a) => ({
    id: a.id,
    settlement_id: a.settlement_id,
    repo: repoLabel(a.repo),
    ecosystem: a.ecosystem,
    package: a.package,
    amount: major(a.amount_minor, a.currency),
    currency: a.currency,
    status: a.status,
    created_at: a.created_at,
    expires_at: a.expires_at,
  }));

  const payouts = all<any>(
    `SELECT p.sender_item_id, p.settlement_id, p.repo, p.amount_minor, p.fee_minor, p.currency, p.transaction_status, p.status_changed_at
       FROM payout_items p JOIN settlements s ON s.id = p.settlement_id
      WHERE s.user_id = ? ORDER BY p.updated_at`,
    userId,
  ).map((p) => ({
    sender_item_id: p.sender_item_id,
    settlement_id: p.settlement_id,
    repo: repoLabel(p.repo),
    amount: major(p.amount_minor, p.currency),
    fee: major(p.fee_minor, p.currency),
    currency: p.currency,
    transaction_status: p.transaction_status ?? "PENDING",
    status_changed_at: p.status_changed_at,
  }));

  // One row per repo this viewer's money touched: its best claim, or "unclaimed" when nobody has proven they run it.
  const rawRepos = new Set(
    all<{ repo: string }>(
      `SELECT repo FROM allocations WHERE user_id = ? AND repo IS NOT NULL
       UNION SELECT p.repo FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE s.user_id = ?`,
      userId,
      userId,
    ).map((r) => r.repo),
  );
  const rank = (status: string) => (status === "verified" ? 0 : status === "pending" ? 1 : status === "receiver_unclaimed" ? 2 : 3);
  const maintainers = [...rawRepos].map((repo) => {
    const claims = all<{ method: string; status: string; verified_at: string | null; created_at: string }>(
      "SELECT method, status, verified_at, created_at FROM claims WHERE repo = ?",
      repo,
    ).sort((a, b) => rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at));
    const best = claims[0];
    return { repo: repoLabel(repo), method: best?.method ?? null, status: best?.status ?? "unclaimed", verified_at: best?.verified_at ?? null };
  });

  const ledger = all<any>(
    "SELECT id, occurred_at, kind, amount_minor, currency, ref_type FROM ledger WHERE user_id = ? ORDER BY occurred_at, id",
    userId,
  ).map((l) => ({ id: l.id, occurred_at: l.occurred_at, kind: l.kind, amount: major(l.amount_minor, l.currency), currency: l.currency, ref_type: l.ref_type }));

  const moneyEvents = all<any>(
    "SELECT id, at, type, from_node, to_node, amount_minor, currency, kind, repo, status_to FROM money_events WHERE user_id = ? ORDER BY at, id",
    userId,
  ).map((e) => ({
    id: e.id,
    at: e.at,
    type: e.type,
    from_node: e.from_node,
    to_node: e.to_node,
    amount: major(e.amount_minor, e.currency),
    currency: e.currency,
    kind: e.kind,
    repo: repoLabel(e.repo),
    status_to: e.status_to,
  }));

  return {
    generatedAt: new Date().toISOString(),
    currency,
    sources: { sessions, shares, allocations, payouts, maintainers, ledger, moneyEvents },
  };
}
