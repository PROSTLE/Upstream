// Public, read-only views for maintainers: what agents relied on in a repo, what is held for it,
// a README badge, and the money trail that explains every allocation. Nothing here writes.
import { activeRun } from "./attribution/run.ts";
import { payableClaim } from "./claims.ts";
import { config } from "./config.ts";
import { db, json, NOT_CHECK_USER, now } from "./db.ts";
import { formatMoney, fromMinor } from "./money.ts";

export interface RepoSummary {
  repo: string;
  currency: string;
  packages: { ecosystem: string; name: string }[];
  sessions_relied: number;
  last_relied_at: string | null;
  held: string;
  in_flight: string;
  paid: string;
  held_minor: number;
  paid_minor: number;
  claim: {
    status: "verified" | "pending" | "none";
    github_login: string | null;
    verified_at: string | null;
    /** How ownership was proven, so a maintainer or funder can check it themselves. Never the payout email. */
    proof: { method: "github_admin"; permission: "admin" | "maintain" | null } | { method: "funding_yml_token"; path: string | null; link: string | null } | null;
  };
  /** Payout items PayPal has reported on, with PayPal's own ids so the maintainer can find each one in their PayPal activity. */
  payouts: { at: string; amount: string; status: string; transaction_id: string | null }[];
}

function repoPackages(repo: string) {
  return db().prepare("SELECT ecosystem, name FROM packages WHERE repo = ? ORDER BY name").all(repo) as { ecosystem: string; name: string }[];
}

/** Attributed sessions whose active run gives a positive weight to one of these packages. Public counts use everyone's; a trail uses one person's. */
function reliedSessions(pkgs: { ecosystem: string; name: string }[], userId?: string) {
  const keys = new Set(pkgs.map((p) => `${p.ecosystem}:${p.name}`));
  if (!keys.size) return [];
  const sessions = db()
    .prepare(`SELECT id, started_at, last_event_at FROM sessions WHERE status = 'attributed' AND ${userId ? "user_id = ?" : NOT_CHECK_USER} ORDER BY started_at`)
    .all(...(userId ? [userId] : [])) as { id: string; started_at: string; last_event_at: string }[];
  const out: { id: string; last_event_at: string; weights: ReturnType<typeof weightsFor> }[] = [];
  for (const s of sessions) {
    const w = weightsFor(s.id, keys);
    if (w.length) out.push({ id: s.id, last_event_at: s.last_event_at, weights: w });
  }
  return out;
}

function weightsFor(sessionId: string, keys: Set<string>) {
  const run = activeRun(sessionId);
  if (!run) return [];
  const evidence = new Map(run.candidates.evidence?.map((e) => [e.id, e]) ?? []);
  return run.validated.weights
    .filter((w) => w.weight > 0 && keys.has(`${w.ecosystem}:${w.name}`))
    .map((w) => ({
      ecosystem: w.ecosystem,
      name: w.name,
      weight: w.weight,
      classification: w.classification,
      rationale: w.rationale,
      method: run.method,
      model: run.model,
      evidence: w.evidence_ids.map((id) => ({ id, kind: evidence.get(id)?.kind ?? null, strength: evidence.get(id)?.strength ?? null })),
    }));
}

function allocationSums(repo: string, currency: string) {
  const rows = db()
    .prepare(`SELECT status, COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE repo = ? AND currency = ? AND status IN ('reserved','in_batch','paid') AND ${NOT_CHECK_USER} GROUP BY status`)
    .all(repo, currency) as { status: string; t: number }[];
  const s = (k: string) => Number(rows.find((r) => r.status === k)?.t ?? 0);
  return { reserved: s("reserved"), inBatch: s("in_batch"), paid: s("paid") };
}

function claimState(repo: string): RepoSummary["claim"] {
  const payable = payableClaim(repo);
  if (payable) {
    const ev = payable.evidence as { permissions?: { admin?: boolean; maintain?: boolean }; funding_yml_path?: string };
    const proof: RepoSummary["claim"]["proof"] =
      payable.method === "github_admin"
        ? { method: "github_admin", permission: ev.permissions?.admin ? "admin" : ev.permissions?.maintain ? "maintain" : null }
        : { method: "funding_yml_token", path: ev.funding_yml_path ?? null, link: payable.token ? `${config.PUBLIC_BASE_URL}/c/${payable.token}` : null };
    return { status: "verified", github_login: payable.github_login, verified_at: payable.verified_at, proof };
  }
  const pending = db().prepare("SELECT id FROM claims WHERE repo = ? AND status = 'pending' LIMIT 1").get(repo);
  return { status: pending ? "pending" : "none", github_login: null, verified_at: null, proof: null };
}

function payoutsFor(repo: string): RepoSummary["payouts"] {
  return (db()
    .prepare("SELECT amount_minor, currency, transaction_status, transaction_id, COALESCE(status_changed_at, updated_at) AS at FROM payout_items WHERE repo = ? AND transaction_status IS NOT NULL ORDER BY at DESC LIMIT 20")
    .all(repo) as { amount_minor: number; currency: string; transaction_status: string; transaction_id: string | null; at: string }[])
    .map((p) => ({ at: p.at, amount: fromMinor(p.amount_minor, p.currency), status: p.transaction_status, transaction_id: p.transaction_id }));
}

export function repoSummary(repo: string): RepoSummary | undefined {
  const currency = config.TITHE_CURRENCY;
  const packages = repoPackages(repo);
  const sums = allocationSums(repo, currency);
  const known = packages.length > 0 || sums.reserved + sums.inBatch + sums.paid > 0;
  if (!known) return undefined;
  const relied = reliedSessions(packages);
  return {
    repo,
    currency,
    packages,
    sessions_relied: relied.length,
    last_relied_at: relied.reduce<string | null>((a, s) => (!a || s.last_event_at > a ? s.last_event_at : a), null),
    held: fromMinor(sums.reserved, currency),
    in_flight: fromMinor(sums.inBatch, currency),
    paid: fromMinor(sums.paid, currency),
    held_minor: sums.reserved,
    paid_minor: sums.paid,
    claim: claimState(repo),
    payouts: payoutsFor(repo),
  };
}

/** Repos with money held or paid, biggest first: the claim page shows maintainers what is waiting. */
export function reposWithMoney(limit = 50): RepoSummary[] {
  const rows = db()
    .prepare(`SELECT DISTINCT repo FROM allocations WHERE repo IS NOT NULL AND currency = ? AND status IN ('reserved','in_batch','paid') AND ${NOT_CHECK_USER}`)
    .all(config.TITHE_CURRENCY) as { repo: string }[];
  return rows
    .map((r) => repoSummary(r.repo))
    .filter((s): s is RepoSummary => Boolean(s))
    .sort((a, b) => b.held_minor - a.held_minor || b.paid_minor - a.paid_minor || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}

/**
 * What the public home page shows: totals across everyone, plus recently credited packages and the kinds of evidence behind them.
 * Package names are already public on repo pages. Projects, sessions, people and the AI's written reasons, which can name files, never appear here.
 */
export function publicActivity(limit = 4) {
  const currency = config.TITHE_CURRENCY;
  const sessions = db().prepare(`SELECT id FROM sessions WHERE status = 'attributed' AND ${NOT_CHECK_USER} ORDER BY last_event_at DESC`).all() as { id: string }[];
  const credited = new Map<string, { ecosystem: string; name: string; classification: string; signals: string[] }>();
  const seen = new Set<string>();
  let reviewed = 0;
  for (const s of sessions) {
    const run = activeRun(s.id);
    if (!run) continue;
    reviewed++;
    for (const c of run.candidates.candidates ?? []) seen.add(`${c.ecosystem}:${c.name}`);
    for (const w of run.validated.weights) {
      const key = `${w.ecosystem}:${w.name}`;
      if (w.weight <= 0 || credited.has(key)) continue;
      const candidate = run.candidates.candidates?.find((c) => c.ecosystem === w.ecosystem && c.name === w.name);
      credited.set(key, { ecosystem: w.ecosystem, name: w.name, classification: w.classification, signals: Object.keys(candidate?.counts ?? {}) });
    }
  }
  const sum = (status: string) => Number((db().prepare(`SELECT COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE status = ? AND currency = ? AND ${NOT_CHECK_USER}`).get(status, currency) as { t: number }).t);
  return {
    currency,
    sessions_reviewed: reviewed,
    packages_credited: credited.size,
    packages_left_out: [...seen].filter((k) => !credited.has(k)).length,
    verified_maintainers: Number((db().prepare("SELECT COUNT(DISTINCT repo) AS n FROM claims WHERE status = 'verified'").get() as { n: number }).n),
    paid: fromMinor(sum("paid"), currency),
    held: fromMinor(sum("reserved"), currency),
    recent: [...credited.values()].slice(0, limit).map((c) => ({
      ...c,
      repo: (db().prepare("SELECT repo FROM packages WHERE ecosystem = ? AND name = ?").get(c.ecosystem, c.name) as { repo: string | null } | undefined)?.repo ?? null,
    })),
  };
}

/** The packages in this person's reviewed sessions and payouts: nobody sees what other people's agents used. */
export function packagesForUser(userId: string): { ecosystem: string; name: string }[] {
  const seen = new Map<string, { ecosystem: string; name: string }>();
  const add = (ecosystem: string, name: string) => seen.set(`${ecosystem}:${name}`, { ecosystem, name });
  const runs = db().prepare("SELECT r.candidates_json FROM attribution_runs r JOIN sessions s ON s.id = r.session_id WHERE s.user_id = ?").all(userId) as { candidates_json: string }[];
  for (const r of runs) for (const c of json<{ candidates?: { ecosystem: string; name: string }[] }>(r.candidates_json, {}).candidates ?? []) add(c.ecosystem, c.name);
  for (const a of db().prepare("SELECT DISTINCT ecosystem, package FROM allocations WHERE user_id = ?").all(userId) as { ecosystem: string; package: string }[]) add(a.ecosystem, a.package);
  const known = db().prepare("SELECT 1 FROM packages WHERE ecosystem = ? AND name = ?");
  return [...seen.values()].filter((p) => known.get(p.ecosystem, p.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** One person's allocations for a repo, joined to their sessions and the cited evidence that produced them. */
export function moneyTrail(repo: string, userId: string) {
  const currency = config.TITHE_CURRENCY;
  const packages = repoPackages(repo);
  const keys = new Set(packages.map((p) => `${p.ecosystem}:${p.name}`));
  const allocations = (db()
    .prepare("SELECT * FROM allocations WHERE repo = ? AND user_id = ? AND status != 'planned' ORDER BY created_at DESC")
    .all(repo, userId) as any[]).map((a) => ({
    id: a.id,
    settlement_id: a.settlement_id,
    package: `${a.ecosystem}:${a.package}`,
    amount: fromMinor(a.amount_minor, a.currency),
    status: a.status,
    payout_item_ref: a.payout_item_ref,
    created_at: a.created_at,
    expires_at: a.expires_at,
    session_ids: json<string[]>(a.session_ids_json, []),
  }));
  const sessionIds = new Set(allocations.flatMap((a) => a.session_ids));
  for (const s of reliedSessions(packages, userId)) sessionIds.add(s.id);
  const sessions = [...sessionIds].map((id) => {
    const row = db().prepare("SELECT id, project, started_at FROM sessions WHERE id = ?").get(id) as
      | { id: string; project: string | null; started_at: string }
      | undefined;
    return { id, project: row?.project ?? null, started_at: row?.started_at ?? null, weights: weightsFor(id, keys) };
  });
  const items = (db()
    .prepare("SELECT p.sender_item_id, p.settlement_id, p.amount_minor, p.currency, p.transaction_status, p.fee_minor, p.updated_at FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE p.repo = ? AND s.user_id = ? ORDER BY p.updated_at DESC")
    .all(repo, userId) as any[]).map((i) => ({
    sender_item_id: i.sender_item_id,
    settlement_id: i.settlement_id,
    amount: fromMinor(i.amount_minor, i.currency),
    fee: i.fee_minor != null ? fromMinor(i.fee_minor, i.currency) : null,
    transaction_status: i.transaction_status,
    updated_at: i.updated_at,
  }));
  return { repo, currency, summary: repoSummary(repo) ?? null, allocations, sessions, payout_items: items };
}

/**
 * What an invitation to a maintainer says, from this person's own records: the same data as the money trail, reduced to counts.
 * Only repos with money held and no verified maintainer have anything to invite anyone to.
 */
export function inviteDetails(repo: string, userId: string) {
  const currency = config.TITHE_CURRENCY;
  const held = db()
    .prepare("SELECT amount_minor, package, session_ids_json, expires_at FROM allocations WHERE repo = ? AND user_id = ? AND status = 'reserved' AND currency = ? ORDER BY expires_at")
    .all(repo, userId, currency) as { amount_minor: number; package: string; session_ids_json: string; expires_at: string | null }[];
  if (!held.length) return { error: "You have no money held for this repository." as const };
  if (payableClaim(repo)) return { error: "This repository already has a verified maintainer." as const };
  const packages = [...new Set(held.map((a) => a.package))].sort();
  const sessionIds = new Set(held.flatMap((a) => json<string[]>(a.session_ids_json, [])));
  // Counted from the runs that gave these packages a share, so every number in the message can be traced.
  const evidence: Record<string, number> = {};
  let usageLines = 0;
  for (const id of sessionIds) {
    const run = activeRun(id);
    for (const c of run?.candidates.candidates ?? []) {
      if (!packages.includes(c.name)) continue;
      usageLines += c.usage_lines;
      for (const [kind, n] of Object.entries(c.counts)) evidence[kind] = (evidence[kind] ?? 0) + n;
    }
  }
  const invited = db().prepare("SELECT created_at, channel FROM invites WHERE repo = ? AND user_id = ?").get(repo, userId) as { created_at: string; channel: string } | undefined;
  return {
    repo,
    held: fromMinor(held.reduce((a, r) => a + r.amount_minor, 0), currency),
    currency,
    expires_at: held.map((a) => a.expires_at).filter((e): e is string => Boolean(e)).sort()[0] ?? null,
    sessions: sessionIds.size,
    packages,
    evidence,
    usage_lines: usageLines,
    claim_url: `${config.PUBLIC_BASE_URL}/claim?repo=${repo.replace("github.com/", "")}`,
    invited: invited ?? null,
  };
}

const INVITE_CHANNELS = new Set(["github_issue", "copied_text", "copied_link"]);

/** Remembers that this person invited the maintainer. Nothing is posted anywhere: they did it themselves. */
export function recordInvite(repo: string, userId: string, channel: unknown) {
  if (typeof channel !== "string" || !INVITE_CHANNELS.has(channel)) throw new Error("Unknown invite channel.");
  db()
    .prepare("INSERT INTO invites(repo, user_id, created_at, channel) VALUES (?,?,?,?) ON CONFLICT(repo, user_id) DO UPDATE SET created_at = excluded.created_at, channel = excluded.channel")
    .run(repo, userId, now(), channel);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Approximate Verdana 11px advance widths, the convention README badges use, so the text fits its box.
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ilj.,:'|!]/.test(ch) ? 3.6 : /[mwMW@]/.test(ch) ? 10 : /[A-Z0-9$]/.test(ch) ? 7.5 : 6.4;
  return Math.ceil(w);
}

/** A shields-style SVG for a repo's README. Unknown repos get a neutral "not yet used" badge, never an error. */
export function badgeSvg(summary: RepoSummary | undefined): string {
  const label = config.BRAND_NAME.toLowerCase();
  let message = "not yet used by agents";
  let color = "#7c8597";
  if (summary) {
    if (summary.held_minor > 0 && summary.claim.status !== "verified") {
      message = `${formatMoney(summary.held_minor, summary.currency)} waiting · claim it`;
      color = "#c27803";
    } else if (summary.paid_minor > 0) {
      message = `${formatMoney(summary.paid_minor, summary.currency)} paid by agents`;
      color = "#15803d";
    } else if (summary.sessions_relied > 0) {
      message = `relied on in ${summary.sessions_relied} agent session${summary.sessions_relied === 1 ? "" : "s"}`;
      color = "#2f5bea";
    } else if (summary.claim.status === "verified") {
      message = "verified maintainer";
      color = "#15803d";
    }
  }
  const lw = textWidth(label) + 12;
  const mw = textWidth(message) + 12;
  const w = lw + mw;
  const title = esc(`${label}: ${message}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}"><title>${title}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#2b2f3a"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text></g></svg>`;
}
