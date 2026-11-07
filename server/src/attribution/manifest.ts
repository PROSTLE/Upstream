// What funding by dependency list would pay: the same share to every declared package.
// It approximates tools that split money by manifests; it is not any one tool's exact algorithm. Comparison only, never paid.
import type { CandidateSet } from "../evidence/candidates.ts";
import type { Validated } from "./validate.ts";

export function manifestComparison(set: CandidateSet): Validated | null {
  const declared = set.candidates.filter((c) => c.in_initial_manifest || c.in_final_manifest);
  if (!declared.length) return null;
  const share = Math.round((1 / declared.length) * 1e6) / 1e6;
  return {
    // Skips the validator on purpose: it would zero every package with no session evidence, which is exactly what this method can't see.
    weights: declared.map((c) => ({
      ecosystem: c.ecosystem,
      name: c.name,
      classification: "supporting",
      weight: share,
      proposed_weight: share,
      evidence_ids: [],
      rationale: "Declared in the dependency list. An equal split pays every declared package the same.",
    })),
    unallocated: 0,
    flags: [],
  };
}
