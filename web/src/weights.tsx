// How a run's numbers are shown wherever money shares appear (session page, receipt, /check).
// The per-package cap makes many paid packages show the same share, so the method's own ranking is shown beside it.
import { Info } from "lucide-react";
import { pct } from "./format.ts";

export type WeightRow = { ecosystem: string; name: string; weight: number; proposed_weight?: number };

const key = (w: WeightRow) => `${w.ecosystem}:${w.name}`;

/** Paid packages, largest share first. Equal shares (usually the cap) keep the method's ranking. */
export function paidByRank<T extends WeightRow>(weights: T[]): T[] {
  return weights.filter((w) => w.weight > 0).sort((a, b) => b.weight - a.weight || (b.proposed_weight ?? 0) - (a.proposed_weight ?? 0));
}

/** Each paid package's part of what the method proposed for the paid packages. Null when the run has no usable proposal. */
export function importanceShares(paid: WeightRow[]): Map<string, number> | null {
  const sum = paid.reduce((a, w) => a + Math.max(w.proposed_weight ?? 0, 0), 0);
  if (!(sum > 0)) return null;
  return new Map(paid.map((w) => [key(w), Math.max(w.proposed_weight ?? 0, 0) / sum]));
}

const IMPORTANCE_LABEL: Record<string, string> = { llm: "AI importance", baseline: "Import-count score" };

function Bar({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="share-row">
      <span className="muted small">{label}</span>
      <div className={`bar ${tone ?? ""}`} role="img" aria-label={`${label}: ${pct(value, 1)}`}><span style={{ width: `${Math.max(value * 100, value > 0 ? 2 : 0)}%` }} /></div>
      <span className="num small" style={{ fontWeight: 600, textAlign: "right" }}>{pct(value, value < 0.1 ? 1 : 0)}</span>
    </div>
  );
}

/** "AI importance" and "Paid share" for one package. An equal split has no ranking, so it only shows its share. */
export function ShareBars({ method, row, shares }: { method: string; row: WeightRow; shares: Map<string, number> | null }) {
  const label = IMPORTANCE_LABEL[method];
  const importance = label ? shares?.get(key(row)) : undefined;
  return (
    <div className="share-bars">
      {importance != null && <Bar label={label} value={importance} tone="violet" />}
      <Bar label="Paid share" value={row.weight} />
    </div>
  );
}

/** Why part of a session's budget wasn't paid to anyone. */
export function LeftoverNote({ flags, unallocated, maxShare, paid }: { flags: { code: string }[]; unallocated: number; maxShare?: number | null; paid: number }) {
  if (unallocated <= 0.0001) return null;
  const capped = flags.some((f) => f.code === "CAP_LEFTOVER");
  return (
    <div className="callout">
      <Info size={16} color="var(--muted)" />
      <div className="small">
        {capped && maxShare != null
          ? `${pct(unallocated, unallocated < 0.1 ? 1 : 0)} of this session's budget stays in your pool because no package may take more than ${pct(maxShare)} of a session.`
          : paid
            ? `${pct(unallocated, 1)} of this session's budget stays in your pool.`
            : "No package qualified, so this session's budget stays in your pool."}
      </div>
    </div>
  );
}
