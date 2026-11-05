import { useState } from "react";
import { Link } from "react-router-dom";
import { FlaskConical, Info, Scale, Target, Trophy } from "lucide-react";
import { useApi } from "../api.ts";
import { pct, plural } from "../format.ts";
import { BrandIcon, Card, Empty, ErrorBox, Loading, PageHead } from "../ui.tsx";
import { Chart, useNeutralFill } from "../data.tsx";

const METRICS: { key: string; label: string; better: "high" | "low"; fmt: (v: number | null) => string }[] = [
  { key: "precision", label: "Precision (paid packages that deserved it)", better: "high", fmt: (v) => pct(v, 1) },
  { key: "recall", label: "Recall (deserving packages that got paid)", better: "high", fmt: (v) => pct(v, 1) },
  { key: "f1", label: "F1", better: "high", fmt: (v) => pct(v, 1) },
  { key: "accuracy", label: "Accuracy (used vs not used)", better: "high", fmt: (v) => pct(v, 1) },
  { key: "mean_weight_l1", label: "Mean weight error (L1, 0–2)", better: "low", fmt: (v) => (v == null ? "—" : v.toFixed(3)) },
];

export function Eval() {
  const { data: report, error, loading } = useApi<any>("/api/eval");
  const [scope, setScope] = useState<"all" | "blind">("all");
  const neutral = useNeutralFill();
  if (loading && !report) return <div className="page"><Loading /></div>;
  if (error || !report) return <div className="page"><ErrorBox error={error ?? "Could not load eval"} /></div>;
  const data = scope === "blind" ? report.blind : report;
  const total = report.llm.sessions;
  const blindCount = report.blind.llm.sessions;
  const n = data.llm.sessions;

  return (
    <div className="page">
      <PageHead
        eyebrow="More"
        title="AI accuracy"
        subtitle="Is the AI better than simply counting imports? Mark which packages really mattered in real sessions, then compare both on the same sessions."
      />
      {total > 0 && (
        <div className="row" style={{ gap: 10, marginBottom: 16 }}>
          <div className="tabs">
            <button className={`tab ${scope === "all" ? "active" : ""}`} onClick={() => setScope("all")}>All labelled ({total})</button>
            <button className={`tab ${scope === "blind" ? "active" : ""}`} onClick={() => setScope("blind")}>Blind only ({blindCount})</button>
          </div>
          <span className="muted small">Blind: every label was saved before any attribution ran for that session, so neither method's weights could have influenced it.</span>
        </div>
      )}
      {n === 0 ? (
        <Card>
          <Empty icon={<FlaskConical size={22} />} title={scope === "blind" && total > 0 ? "No blind-labelled sessions yet" : "No labelled sessions yet"}>
            Open a <Link to="/sessions">session</Link>, mark each package as meaningful, incidental or not used in “Your ground truth” <strong>before</strong> you attribute it (that keeps the label blind), then run attribution. Scores appear here; nothing is precomputed.
          </Empty>
        </Card>
      ) : (
        <>
          <Verdict data={data} n={n} />
          <div className="split">
            <Card title={`Scores on ${plural(n, "labelled session")}`} icon={<Target size={17} />} tone="violet">
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr className="muted small" style={{ textAlign: "left" }}>
                    <th style={{ padding: "6px 0", fontWeight: 560 }}>Metric</th>
                    <th style={{ fontWeight: 560 }}><span className="row" style={{ gap: 6 }}><BrandIcon name="meta" size={13} />Muse Spark</span></th>
                    <th style={{ fontWeight: 560 }}>Baseline</th>
                  </tr>
                </thead>
                <tbody>
                  {METRICS.map((m) => {
                    const a = data.llm[m.key];
                    const b = data.baseline[m.key];
                    const winA = a != null && b != null && (m.better === "high" ? a > b : a < b);
                    const winB = a != null && b != null && (m.better === "high" ? b > a : b < a);
                    return (
                      <tr key={m.key} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 0" }}>{m.label}</td>
                        <td className="num" style={{ fontWeight: winA ? 700 : 500, color: winA ? "var(--green)" : undefined }}>{m.fmt(a)}</td>
                        <td className="num" style={{ fontWeight: winB ? 700 : 500, color: winB ? "var(--green)" : undefined }}>{m.fmt(b)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted small" style={{ marginTop: 12 }}>
                Confusion counts — Muse Spark: TP {data.llm.tp}, FP {data.llm.fp}, FN {data.llm.fn}, TN {data.llm.tn}. Baseline: TP {data.baseline.tp}, FP {data.baseline.fp}, FN {data.baseline.fn}, TN {data.baseline.tn}.
              </p>
            </Card>
            <Card title="Side by side" icon={<Scale size={17} />}>
              <Chart
                height={260}
                options={{
                  data: ["precision", "recall", "f1", "accuracy"].map((k) => ({ metric: k.toUpperCase(), muse: data.llm[k] != null ? +(data.llm[k] * 100).toFixed(1) : undefined, baseline: data.baseline[k] != null ? +(data.baseline[k] * 100).toFixed(1) : undefined })),
                  series: [
                    { type: "bar", xKey: "metric", yKey: "muse", yName: "Muse Spark", cornerRadius: 4 },
                    { type: "bar", xKey: "metric", yKey: "baseline", yName: "Baseline", cornerRadius: 4, fill: neutral, stroke: neutral },
                  ],
                  axes: { y: { type: "number", min: 0, max: 100, label: { formatter: ({ value }: any) => `${value}%` } }, x: { type: "category" } },
                  legend: { position: "bottom" },
                } as any}
              />
            </Card>
          </div>
          <Card title="Per session" icon={<FlaskConical size={17} />}>
            <div className="list" style={{ margin: "-16px -20px -20px" }}>
              {report.perSession.filter((s: any) => scope === "all" || s.blind).map((s: any) => (
                <Link key={s.session_id} to={`/sessions/${s.session_id}`} className="list-item" style={{ color: "inherit" }}>
                  <code>{s.session_id.slice(0, 12)}…</code>
                  <span className="muted small">{plural(s.labelled, "label")}</span>
                  <span className={`pill ${s.blind ? "green" : ""}`}>{s.blind ? "blind" : "labelled after attribution"}</span>
                  <div className="spacer" />
                  {!s.llm && <span className="pill amber">no Muse Spark run</span>}
                  {!s.baseline && <span className="pill amber">no baseline</span>}
                </Link>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** A sentence summary of the table, counted from the same numbers. Ties and undefined metrics count for neither side. */
function Verdict({ data, n }: { data: any; n: number }) {
  let muse = 0, base = 0, compared = 0;
  for (const m of METRICS) {
    const a = data.llm[m.key], b = data.baseline[m.key];
    if (a == null || b == null) continue;
    compared++;
    if (m.better === "high" ? a > b : a < b) muse++;
    else if (m.better === "high" ? b > a : b < a) base++;
  }
  const lead = muse > base ? "Muse Spark is ahead" : base > muse ? "The baseline is ahead" : "Muse Spark and the baseline are level";
  return (
    <section className="hero" aria-label="Summary">
      <span className={`icon-tile ${muse > base ? "green" : base > muse ? "amber" : ""}`} style={{ width: 48, height: 48 }}><Trophy size={22} /></span>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div className="eyebrow">On {n} labelled session{n === 1 ? "" : "s"}</div>
        <h2 style={{ marginTop: 2 }}>{lead}{compared ? `: ${muse} of ${compared} metrics to Muse Spark, ${base} to the baseline` : ""}</h2>
        <p>
          The baseline counts imports × lines using them. It can't see a library whose source the agent studied before reimplementing it, or new code against an import that already existed; that's where Muse Spark should earn its place. With few sessions, read this as a signal, not a result.
        </p>
      </div>
      <div className="callout" style={{ maxWidth: 360 }}>
        <Info size={16} color="var(--muted)" />
        <div className="small"><strong>Precision</strong>: of the packages a method paid, how many you said deserved it. <strong>Recall</strong>: of the packages you said deserved it, how many got paid. <strong>L1</strong>: how far the weights are from yours (0 is perfect).</div>
      </div>
    </section>
  );
}
