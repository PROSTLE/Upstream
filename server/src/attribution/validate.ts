// "AI proposes, code disposes": every rule here runs after the model and cannot be argued with.
import type { CandidateSet } from "../evidence/candidates.ts";

export type Classification = "meaningful" | "supporting" | "incidental" | "not_used";

export interface ProposedWeight {
  ecosystem: string;
  name: string;
  classification: Classification;
  weight: number;
  evidence_ids: string[];
  rationale: string;
}

export interface Flag {
  level: "error" | "warn" | "info";
  code: string;
  package?: string;
  message: string;
}

export interface ValidatedWeight extends ProposedWeight {
  proposed_weight: number;
}

export interface Validated {
  weights: ValidatedWeight[];
  unallocated: number;
  flags: Flag[];
}

const WEAK_ONLY_KINDS = new Set(["web_search", "source_search", "docs_mcp", "docs_fetch"]);

export function validate(set: CandidateSet, proposal: ProposedWeight[], opts: { maxShare: number }): Validated {
  const flags: Flag[] = [];
  const byKey = new Map(set.candidates.map((c) => [`${c.ecosystem}:${c.name}`, c]));
  const allEvidence = new Set([...set.evidence.map((e) => e.id), ...set.unattributed.map((u) => u.id)]);
  const merged = new Map<string, ValidatedWeight>();

  for (const p of proposal) {
    const key = `${p.ecosystem}:${p.name}`;
    const cand = byKey.get(key);
    if (!cand) {
      flags.push({ level: "error", code: "HALLUCINATED_PACKAGE", package: key, message: `${key} is not a candidate in this session's evidence; dropped.` });
      continue;
    }
    let weight = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0;
    const unknown = p.evidence_ids.filter((id) => !allEvidence.has(id));
    if (unknown.length) {
      flags.push({ level: "error", code: "CITED_UNKNOWN_EVIDENCE", package: key, message: `Cited evidence that does not exist: ${unknown.join(", ")}.` });
    }
    const own = p.evidence_ids.filter((id) => cand.evidence_ids.includes(id));
    if (p.classification === "incidental" || p.classification === "not_used") weight = 0;
    if (weight > 0 && own.length === 0) {
      flags.push({
        level: "error",
        code: "UNCORROBORATED",
        package: key,
        message:
          cand.status === "present_only"
            ? `${key} is only present in the manifest; no session evidence links it. Weight set to 0.`
            : `None of the cited evidence is linked to ${key}. Weight set to 0.`,
      });
      weight = 0;
    }
    if (weight > 0.3 && cand.evidence_ids.length > 0) {
      const kinds = Object.keys(cand.counts);
      if (kinds.every((k) => WEAK_ONLY_KINDS.has(k))) {
        flags.push({ level: "warn", code: "WEAK_EVIDENCE_HIGH_WEIGHT", package: key, message: `${key} got ${(weight * 100).toFixed(0)}% from docs/search evidence only.` });
      }
    }
    const prev = merged.get(key);
    if (prev) {
      flags.push({ level: "warn", code: "DUPLICATE_ENTRY", package: key, message: `${key} appeared twice; weights merged.` });
      prev.weight += weight;
      prev.proposed_weight += p.weight;
      prev.evidence_ids = [...new Set([...prev.evidence_ids, ...own])];
    } else {
      merged.set(key, { ...p, weight, proposed_weight: p.weight, evidence_ids: own });
    }
  }

  for (const c of set.candidates) {
    const key = `${c.ecosystem}:${c.name}`;
    const strong = c.counts.import_added || c.counts.dep_install || c.counts.manifest_add || c.counts.api_usage || c.counts.logic_reused;
    if (strong && !(merged.get(key)?.weight ?? 0)) {
      flags.push({ level: "warn", code: "STRONG_CANDIDATE_UNPAID", package: key, message: `${key} has install/import evidence but received no weight.` });
    }
  }

  const weights = [...merged.values()];
  const total = weights.reduce((a, w) => a + w.weight, 0);
  if (total > 0) for (const w of weights) w.weight /= total;

  // Water-fill the per-package cap; anything that cannot be placed stays unallocated (back to the pool).
  const cap = opts.maxShare;
  for (let i = 0; i < weights.length; i++) {
    const over = weights.filter((w) => w.weight > cap + 1e-12);
    if (!over.length) break;
    let excess = 0;
    for (const w of over) {
      excess += w.weight - cap;
      w.weight = cap;
      flags.push({ level: "info", code: "CAPPED", package: `${w.ecosystem}:${w.name}`, message: `Capped at ${(cap * 100).toFixed(0)}% of the session budget.` });
    }
    const room = weights.filter((w) => w.weight > 0 && w.weight < cap);
    const roomTotal = room.reduce((a, w) => a + w.weight, 0);
    if (!room.length || roomTotal <= 0) break;
    for (const w of room) w.weight += (excess * w.weight) / roomTotal;
  }
  for (const w of weights) w.weight = Math.round(w.weight * 1e6) / 1e6;
  const allocated = weights.reduce((a, w) => a + w.weight, 0);
  const unallocated = total > 0 ? Math.max(0, Math.round((1 - allocated) * 1e6) / 1e6) : 1;
  if (total > 0 && unallocated > 0.0001) {
    flags.push({ level: "info", code: "CAP_LEFTOVER", message: `${(unallocated * 100).toFixed(1)}% of this session's budget stays in the pool because of the per-package cap.` });
  }
  if (total === 0) flags.push({ level: "warn", code: "NOTHING_ATTRIBUTED", message: "No package qualified for payment in this session." });

  weights.sort((a, b) => b.weight - a.weight);
  return { weights, unallocated, flags };
}
