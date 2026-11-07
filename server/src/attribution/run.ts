import { config } from "../config.ts";
import { db, json, newId, now, tx } from "../db.ts";
import { buildCandidates, type CandidateSet } from "../evidence/candidates.ts";
import { baselineProposal } from "./baseline.ts";
import { llmProposal } from "./llm.ts";
import { manifestComparison } from "./manifest.ts";
import { validate, type Flag, type Validated } from "./validate.ts";

export type RunMethod = "llm" | "baseline" | "manifest";

export interface RunRecord {
  id: string;
  session_id: string;
  created_at: string;
  method: RunMethod;
  model: string | null;
  candidates: CandidateSet;
  raw_output: unknown;
  validated: Validated;
  flags: Flag[];
  usage: unknown;
  is_active: boolean;
}

function store(
  sessionId: string,
  method: RunMethod,
  set: CandidateSet,
  validated: Validated,
  extra: { model?: string; raw?: unknown; usage?: unknown },
): string {
  const id = newId("run");
  db()
    .prepare(
      `INSERT INTO attribution_runs(id, session_id, created_at, method, model, candidates_json, raw_output_json, validated_json, flags_json, usage_json, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
    )
    .run(
      id,
      sessionId,
      now(),
      method,
      extra.model ?? null,
      JSON.stringify(set),
      extra.raw ? JSON.stringify(extra.raw) : null,
      JSON.stringify(validated),
      JSON.stringify(validated.flags),
      extra.usage ? JSON.stringify(extra.usage) : null,
    );
  return id;
}

export function setActiveRun(sessionId: string, runId: string) {
  tx(() => {
    db().prepare("UPDATE attribution_runs SET is_active = 0 WHERE session_id = ?").run(sessionId);
    db().prepare("UPDATE attribution_runs SET is_active = 1 WHERE id = ? AND session_id = ?").run(runId, sessionId);
    db().prepare("UPDATE sessions SET status = 'attributed' WHERE id = ? AND allocated_settlement_id IS NULL").run(sessionId);
  });
}

/** Divergence between two weight vectors: half the L1 distance, in [0, 1]. */
export function divergence(a: Validated, b: Validated): number {
  const keys = new Set([...a.weights, ...b.weights].map((w) => `${w.ecosystem}:${w.name}`));
  const get = (v: Validated, k: string) => v.weights.find((w) => `${w.ecosystem}:${w.name}` === k)?.weight ?? 0;
  let d = 0;
  for (const k of keys) d += Math.abs(get(a, k) - get(b, k));
  return d / 2;
}

/** `llm: false` runs the deterministic methods only. `maxResolve` bounds the registry lookups when the session comes from the public check page. */
export async function attributeSession(
  sessionId: string,
  options: { llm?: boolean; maxResolve?: number } = {},
): Promise<{ llmRunId?: string; baselineRunId: string; manifestRunId?: string; llmError?: string }> {
  const session = db().prepare("SELECT allocated_settlement_id FROM sessions WHERE id = ?").get(sessionId) as
    | { allocated_settlement_id: string | null }
    | undefined;
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  if (session.allocated_settlement_id) throw new Error("This session is already part of a settlement.");

  const set = await buildCandidates(sessionId, { maxResolve: options.maxResolve });
  const opts = { maxShare: config.POLICY_MAX_PACKAGE_SHARE };
  const base = validate(set, baselineProposal(set), opts);
  const baselineRunId = store(sessionId, "baseline", set, base, {});
  // Stored here and never at import time: a run existing before labels are saved would make those labels not blind.
  const declared = manifestComparison(set);
  const manifestRunId = declared ? store(sessionId, "manifest", set, declared, {}) : undefined;
  if (options.llm === false) return { baselineRunId, manifestRunId };

  try {
    const llm = await llmProposal(set);
    const v = validate(set, llm.proposal, opts);
    const div = divergence(v, base);
    if (div > 0.4) {
      v.flags.push({
        level: "info",
        code: "DIVERGES_FROM_BASELINE",
        message: `LLM and import-count baseline disagree on ${(div * 100).toFixed(0)}% of the budget; review the rationale.`,
      });
    }
    for (const c of llm.raw.concerns) v.flags.push({ level: "warn", code: "MODEL_CONCERN", message: c });
    const llmRunId = store(sessionId, "llm", set, v, { model: llm.model, raw: llm.raw, usage: llm.usage });
    setActiveRun(sessionId, llmRunId);
    return { llmRunId, baselineRunId, manifestRunId };
  } catch (err) {
    return { baselineRunId, manifestRunId, llmError: err instanceof Error ? err.message : String(err) };
  }
}

export function runsForSession(sessionId: string): RunRecord[] {
  const rows = db()
    .prepare("SELECT * FROM attribution_runs WHERE session_id = ? ORDER BY created_at DESC")
    .all(sessionId) as any[];
  return rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    created_at: r.created_at,
    method: r.method,
    model: r.model,
    candidates: json<CandidateSet>(r.candidates_json, {} as CandidateSet),
    raw_output: json(r.raw_output_json, null),
    validated: json<Validated>(r.validated_json, { weights: [], unallocated: 1, flags: [] }),
    flags: json<Flag[]>(r.flags_json, []),
    usage: json(r.usage_json, null),
    is_active: Boolean(r.is_active),
  }));
}

export function activeRun(sessionId: string): RunRecord | undefined {
  return runsForSession(sessionId).find((r) => r.is_active);
}
