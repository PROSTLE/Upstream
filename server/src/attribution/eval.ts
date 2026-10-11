// Compares LLM attribution against the import-count baseline on sessions a human has labelled.
import { db } from "../db.ts";
import { runsForSession, type RunRecord } from "./run.ts";
import type { Validated } from "./validate.ts";

interface LabelRow {
  session_id: string;
  ecosystem: string;
  package: string;
  label: "meaningful" | "incidental" | "not_used";
  weight: number | null;
}

export interface MethodScore {
  sessions: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  mean_weight_l1: number | null;
}

function truthWeights(labels: LabelRow[]): Map<string, number> {
  const meaningful = labels.filter((l) => l.label === "meaningful");
  const explicit = meaningful.every((l) => l.weight != null && l.weight > 0);
  const total = explicit ? meaningful.reduce((a, l) => a + (l.weight ?? 0), 0) : meaningful.length;
  const m = new Map<string, number>();
  for (const l of labels) {
    const k = `${l.ecosystem}:${l.package}`;
    m.set(k, l.label === "meaningful" && total > 0 ? (explicit ? (l.weight ?? 0) : 1) / total : 0);
  }
  return m;
}

function score(pairs: { labels: LabelRow[]; v: Validated }[]): MethodScore {
  let tp = 0, fp = 0, fn = 0, tn = 0, l1sum = 0;
  for (const { labels, v } of pairs) {
    const truth = truthWeights(labels);
    const pred = new Map(v.weights.map((w) => [`${w.ecosystem}:${w.name}`, w.weight]));
    for (const l of labels) {
      const k = `${l.ecosystem}:${l.package}`;
      const p = (pred.get(k) ?? 0) > 0;
      const t = l.label === "meaningful";
      if (p && t) tp++;
      else if (p && !t) fp++;
      else if (!p && t) fn++;
      else tn++;
    }
    const keys = new Set([...truth.keys(), ...pred.keys()]);
    let l1 = 0;
    for (const k of keys) l1 += Math.abs((truth.get(k) ?? 0) - (pred.get(k) ?? 0));
    l1sum += l1;
  }
  const n = pairs.length;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return {
    sessions: n,
    tp, fp, fn, tn,
    precision,
    recall,
    f1: precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null,
    accuracy: tp + fp + fn + tn ? (tp + tn) / (tp + fp + fn + tn) : null,
    mean_weight_l1: n ? l1sum / n : null,
  };
}

export function evalReport() {
  const labels = db().prepare("SELECT * FROM labels").all() as unknown as LabelRow[];
  const bySession = new Map<string, LabelRow[]>();
  for (const l of labels) bySession.set(l.session_id, [...(bySession.get(l.session_id) ?? []), l]);

  const llmPairs: { labels: LabelRow[]; v: Validated }[] = [];
  const basePairs: { labels: LabelRow[]; v: Validated }[] = [];
  const perSession: { session_id: string; labelled: number; llm?: Validated; baseline?: Validated }[] = [];
  for (const [sid, ls] of bySession) {
    const runs = runsForSession(sid);
    const latest = (m: RunRecord["method"]) => runs.find((r) => r.method === m);
    const llm = latest("llm");
    const base = latest("baseline");
    // Compare both methods only on sessions where both exist, so the numbers are like for like.
    if (llm && base) {
      llmPairs.push({ labels: ls, v: llm.validated });
      basePairs.push({ labels: ls, v: base.validated });
    }
    perSession.push({ session_id: sid, labelled: ls.length, llm: llm?.validated, baseline: base?.validated });
  }
  return { llm: score(llmPairs), baseline: score(basePairs), perSession };
}
