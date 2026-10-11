import { Link } from "react-router-dom";
import { FlaskConical, Scale, Target } from "lucide-react";
import { useApi } from "../api.ts";
import { pct } from "../format.ts";
import { BrandIcon, Card, Empty, ErrorBox, Loading, PageHead } from "../ui.tsx";
import { Chart } from "../data.tsx";

const METRICS: { key: string; label: string; better: "high" | "low"; fmt: (v: number | null) => string }[] = [
  { key: "precision", label: "Precision (paid packages that deserved it)", better: "high", fmt: (v) => pct(v, 1) },
  { key: "recall", label: "Recall (deserving packages that got paid)", better: "high", fmt: (v) => pct(v, 1) },
  { key: "f1", label: "F1", better: "high", fmt: (v) => pct(v, 1) },
  { key: "accuracy", label: "Accuracy (used vs not used)", better: "high", fmt: (v) => pct(v, 1) },
  { key: "mean_weight_l1", label: "Mean weight error (L1, 0–2)", better: "low", fmt: (v) => (v == null ? "—" : v.toFixed(3)) },
];

export function Eval() {
  const { data, error, loading } = useApi<any>("/api/eval");
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorBox error={error ?? "Could not load eval"} /></div>;
  const n = data.llm.sessions;

  return (
    <div className="page">
      <PageHead
        title="Attribution eval"
        subtitle="Does Claude add anything over counting imports? Label real sessions with your own judgment, then compare both methods on exactly the same sessions."
      />
      {n === 0 ? (
        <Card>
          <Empty icon={<FlaskConical size={22} />} title="No labelled sessions yet">
            Open a <Link to="/sessions">session</Link>, run attribution, then mark each package as meaningful, incidental or not used in “Your ground truth”. Scores appear here; nothing is precomputed.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="split">
            <Card title={`Scores on ${n} labelled session(s)`} icon={<Target size={17} />} tone="violet">
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr className="muted small" style={{ textAlign: "left" }}>
                    <th style={{ padding: "6px 0", fontWeight: 560 }}>Metric</th>
                    <th style={{ fontWeight: 560 }}><span className="row" style={{ gap: 6 }}><BrandIcon name="claude" size={13} />Claude</span></th>
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
                Confusion counts — Claude: TP {data.llm.tp}, FP {data.llm.fp}, FN {data.llm.fn}, TN {data.llm.tn}. Baseline: TP {data.baseline.tp}, FP {data.baseline.fp}, FN {data.baseline.fn}, TN {data.baseline.tn}.
              </p>
            </Card>
            <Card title="Side by side" icon={<Scale size={17} />}>
              <Chart
                height={260}
                options={{
                  data: ["precision", "recall", "f1", "accuracy"].map((k) => ({ metric: k.toUpperCase(), claude: data.llm[k] != null ? +(data.llm[k] * 100).toFixed(1) : 0, baseline: data.baseline[k] != null ? +(data.baseline[k] * 100).toFixed(1) : 0 })),
                  series: [
                    { type: "bar", xKey: "metric", yKey: "claude", yName: "Claude", cornerRadius: 4 },
                    { type: "bar", xKey: "metric", yKey: "baseline", yName: "Baseline", cornerRadius: 4, fill: "#c9ccd6", stroke: "#c9ccd6" },
                  ],
                  axes: { y: { type: "number", min: 0, max: 100, label: { formatter: ({ value }: any) => `${value}%` } }, x: { type: "category" } },
                  legend: { position: "bottom" },
                } as any}
              />
            </Card>
          </div>
          <Card title="Per session" icon={<FlaskConical size={17} />}>
            <div className="list" style={{ margin: "-16px -20px -20px" }}>
              {data.perSession.map((s: any) => (
                <Link key={s.session_id} to={`/sessions/${s.session_id}`} className="list-item" style={{ color: "inherit" }}>
                  <code>{s.session_id.slice(0, 12)}…</code>
                  <span className="muted small">{s.labelled} label(s)</span>
                  <div className="spacer" />
                  {!s.llm && <span className="pill amber">no Claude run</span>}
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
