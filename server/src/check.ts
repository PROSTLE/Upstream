// The public /check page: anyone can see what their agent really used, with no sign-in, no install and no PayPal.
// Each check runs under a throwaway user and is deleted after 24 hours. What it shows is counts, kinds and names: never payloads or code.
import { createHash, randomBytes } from "node:crypto";
import { isKnownWarning } from "../../web/src/transcript.ts";
import { attributeSession, runsForSession, type RunRecord } from "./attribution/run.ts";
import { payableClaim } from "./claims.ts";
import { config, features } from "./config.ts";
import { CHECK_USER_PREFIX, db, getSetting, json, newId, now, setSetting, tx } from "./db.ts";
import { cleanTranscriptEvents, importTranscript } from "./evidence/import.ts";

const TTL_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
// Every declared package costs several registry calls, and a public page can't let one upload spend those without bound.
const MAX_RESOLVED_PACKAGES = 300;
// Over the hourly limit a person still gets the deterministic methods. This stops one address filling the disk with uploads.
const HARD_STOP_FACTOR = 4;

export type AiState = "running" | "done" | "paused" | "off" | "failed";

interface CheckRow {
  id: string;
  user_id: string;
  session_id: string;
  created_at: string;
  expires_at: string;
  llm_used: number;
  status: "running" | "done" | "failed";
  ai_state: AiState;
  file_name: string | null;
  stats_json: string | null;
  warnings_json: string | null;
}

/** The server's secret for hashing addresses: ADMIN_TOKEN when set, otherwise one generated and kept in the database. */
function serverSecret(): string {
  if (config.ADMIN_TOKEN) return config.ADMIN_TOKEN;
  let s = getSetting("check.secret");
  if (!s) {
    s = randomBytes(32).toString("hex");
    setSetting("check.secret", s);
  }
  return s;
}

export const hashIp = (ip: string) => createHash("sha256").update(`${ip}${serverSecret()}`).digest("hex");

const countSince = (sql: string, ...args: string[]) => Number((db().prepare(sql).get(...args) as { n: number }).n);
const fromThisAddress = (ipHash: string) => countSince("SELECT COUNT(*) AS n FROM public_checks WHERE ip_hash = ? AND created_at > ?", ipHash, new Date(Date.now() - HOUR_MS).toISOString());

/** Decides whether this check gets the AI review. Pure, so every limit can be tested without a model. */
export function aiDecision(input: { llmOn: boolean; aiToday: number; fromAddress: number; maxPerDay: number; maxPerIpPerHour: number }): "running" | "paused" | "off" {
  if (!input.llmOn) return "off";
  return input.aiToday >= input.maxPerDay || input.fromAddress >= input.maxPerIpPerHour ? "paused" : "running";
}

/** True when this address has sent far more than the hourly limit. Checked before the upload is read. */
export function isOverHardLimit(ipHash: string): boolean {
  return fromThisAddress(ipHash) >= Math.max(config.PUBLIC_CHECK_MAX_PER_IP_PER_HOUR, 1) * HARD_STOP_FACTOR;
}

function cleanStats(raw: unknown): Record<string, number> {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const n = (k: string) => (Number.isSafeInteger(s[k]) && (s[k] as number) >= 0 ? (s[k] as number) : 0);
  return { lines: n("lines"), toolCalls: n("toolCalls"), kept: n("kept"), skipped: n("skipped"), tornLines: n("tornLines") };
}

/** Stores the events under a new throwaway user and starts the review. Throws a message the person can act on. */
export function startCheck(input: { events: unknown; fileName: unknown; stats?: unknown; warnings?: unknown; ipHash: string }): { id: string; done: Promise<void> } {
  const events = cleanTranscriptEvents(input.events);
  const aiToday = countSince("SELECT COUNT(*) AS n FROM public_checks WHERE llm_used = 1 AND created_at > ?", new Date(Date.now() - TTL_MS).toISOString());
  const decision = aiDecision({ llmOn: features.llm, aiToday, fromAddress: fromThisAddress(input.ipHash), maxPerDay: config.PUBLIC_CHECK_MAX_PER_DAY, maxPerIpPerHour: config.PUBLIC_CHECK_MAX_PER_IP_PER_HOUR });
  const id = newId("chk");
  const userId = `${CHECK_USER_PREFIX}${randomBytes(9).toString("hex")}`;
  const at = now();
  const warnings = Array.isArray(input.warnings) ? input.warnings.filter(isKnownWarning) : [];
  // The row comes first, so cleanup finds this user whatever happens next.
  tx(() => {
    db().prepare("INSERT INTO users(id, created_at) VALUES (?,?)").run(userId, at);
    db()
      .prepare("INSERT INTO public_checks(id, user_id, session_id, created_at, expires_at, ip_hash, llm_used, status, ai_state, file_name, stats_json, warnings_json) VALUES (?,?,?,?,?,?,?,'running',?,?,?,?)")
      .run(id, userId, `${userId}.${events[0].session_id}`, at, new Date(Date.now() + TTL_MS).toISOString(), input.ipHash, decision === "running" ? 1 : 0, decision, typeof input.fileName === "string" ? input.fileName.slice(0, 200) : null, JSON.stringify(cleanStats(input.stats)), JSON.stringify(warnings));
  });
  importTranscript(events, userId);
  return { id, done: runCheck(id) };
}

async function runCheck(id: string): Promise<void> {
  const row = db().prepare("SELECT session_id, llm_used, ai_state FROM public_checks WHERE id = ?").get(id) as { session_id: string; llm_used: number; ai_state: AiState };
  try {
    const r = await attributeSession(row.session_id, { llm: Boolean(row.llm_used), maxResolve: MAX_RESOLVED_PACKAGES });
    if (r.llmError) console.warn(`check ${id}: the AI review failed: ${r.llmError}`);
    db().prepare("UPDATE public_checks SET status = 'done', ai_state = ? WHERE id = ?").run(r.llmError ? "failed" : row.llm_used ? "done" : row.ai_state, id);
  } catch (e) {
    console.warn(`check ${id} failed:`, e);
    db().prepare("UPDATE public_checks SET status = 'failed', ai_state = 'failed' WHERE id = ?").run(id);
  }
}

// Flag messages can carry text the model chose, so on this shareable page those codes get fixed wording.
const FIXED_FLAG_TEXT: Record<string, string> = {
  HALLUCINATED_PACKAGE: "The AI proposed a package that isn't in this session. Code dropped it.",
  CITED_UNKNOWN_EVIDENCE: "The AI cited evidence that doesn't exist. Code ignored it.",
  MODEL_CONCERN: "The AI flagged something suspicious in this session.",
};

function publicRun(r: RunRecord) {
  return {
    method: r.method,
    model: r.model,
    created_at: r.created_at,
    // No rationale: the model writes it from the session, so it can quote code.
    weights: r.validated.weights.map((w) => ({ ecosystem: w.ecosystem, name: w.name, classification: w.classification, weight: w.weight, proposed_weight: w.proposed_weight })),
    unallocated: r.validated.unallocated,
    flags: r.flags.map((f) => ({ level: f.level, code: f.code, package: FIXED_FLAG_TEXT[f.code] ? undefined : f.package, message: FIXED_FLAG_TEXT[f.code] ?? f.message })),
  };
}

/** What the result page shows. Undefined once a check is unknown or past its 24 hours, even before cleanup has run. */
export function checkView(id: string) {
  const c = db().prepare("SELECT * FROM public_checks WHERE id = ?").get(id) as CheckRow | undefined;
  if (!c || c.expires_at <= now()) return undefined;
  const runs = c.status === "done" ? runsForSession(c.session_id) : [];
  const latest = (m: RunRecord["method"]) => runs.find((r) => r.method === m);
  const main = latest("llm") ?? latest("baseline");
  const set = main?.candidates.candidates ?? [];
  const candidates = set.map((x) => ({ ecosystem: x.ecosystem, name: x.name, status: x.status, counts: x.counts, usage_lines: x.usage_lines, repo: x.repo, declared: x.in_initial_manifest || x.in_final_manifest, added_in_session: x.added_in_session }));
  const repos = [...new Set(candidates.flatMap((x) => (x.repo ? [x.repo] : [])))];
  return {
    id: c.id,
    status: c.status,
    file_name: c.file_name,
    created_at: c.created_at,
    expires_at: c.expires_at,
    stats: json<Record<string, number>>(c.stats_json, {}),
    warnings: json<string[]>(c.warnings_json, []),
    ai_state: c.ai_state,
    declared: candidates.filter((x) => x.declared).length,
    relied_on: main?.validated.weights.filter((w) => w.weight > 0).length ?? 0,
    merely_present: candidates.filter((x) => x.status === "present_only").length,
    runs: (["llm", "baseline", "manifest"] as const).flatMap((m) => {
      const r = latest(m);
      return r ? [publicRun(r)] : [];
    }),
    candidates,
    maintainers: Object.fromEntries(repos.map((repo) => [repo, { status: payableClaim(repo) ? "verified" : "unclaimed", link: `/r/${repo.replace("github.com/", "")}` }])),
    max_package_share: config.POLICY_MAX_PACKAGE_SHARE,
    example_budget: { amount: config.TITHE_AMOUNT, currency: config.TITHE_CURRENCY },
  };
}

/** Deletes every expired check and everything under it. Returns how many went. */
export function cleanupExpiredChecks(at: string = now()): number {
  const expired = db().prepare("SELECT id, user_id FROM public_checks WHERE expires_at <= ?").all(at) as { id: string; user_id: string }[];
  for (const c of expired) {
    if (!c.user_id.startsWith(CHECK_USER_PREFIX)) continue;
    tx(() => {
      const inUser = "session_id IN (SELECT id FROM sessions WHERE user_id = ?)";
      db().prepare(`DELETE FROM evidence WHERE ${inUser}`).run(c.user_id);
      db().prepare(`DELETE FROM attribution_runs WHERE ${inUser}`).run(c.user_id);
      db().prepare(`DELETE FROM labels WHERE ${inUser}`).run(c.user_id);
      db().prepare(`DELETE FROM hook_events WHERE ${inUser}`).run(c.user_id);
      db().prepare("DELETE FROM sessions WHERE user_id = ?").run(c.user_id);
      db().prepare("DELETE FROM users WHERE id = ?").run(c.user_id);
      db().prepare("DELETE FROM public_checks WHERE id = ?").run(c.id);
    });
  }
  return expired.length;
}

/** A check still running when the server stopped will never finish, so its page says so instead of waiting for ever. */
export function failInterruptedChecks() {
  db().prepare("UPDATE public_checks SET status = 'failed', ai_state = 'failed' WHERE status = 'running'").run();
}
