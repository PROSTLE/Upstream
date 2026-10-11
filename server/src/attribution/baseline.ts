// The deterministic baseline the LLM has to beat: import count × diff lines that use the import.
import type { CandidateSet } from "../evidence/candidates.ts";
import type { ProposedWeight } from "./validate.ts";

export function baselineProposal(set: CandidateSet): ProposedWeight[] {
  return set.candidates.map((c) => {
    const imports = c.counts.import_added ?? 0;
    const score = imports * Math.max(1, c.usage_lines);
    const ids = set.evidence
      .filter((e) => e.ecosystem === c.ecosystem && e.package === c.name && (e.kind === "import_added" || e.kind === "api_usage"))
      .map((e) => e.id);
    return {
      ecosystem: c.ecosystem,
      name: c.name,
      classification: score > 0 ? "meaningful" : "not_used",
      weight: score,
      evidence_ids: [...new Set(ids)],
      rationale: `${imports} import(s) × ${Math.max(1, c.usage_lines)} line(s) using them = ${score}`,
    };
  });
}
