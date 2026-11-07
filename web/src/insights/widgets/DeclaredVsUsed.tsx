// "Declared vs used": for each package, what an equal split of the dependency list would pay it
// (grey dot) against what Upstream pays it from the evidence (accent dot). A package the list pays
// but the agent never used gets a red tag. Both values are the package's share of all the session
// budgets in view, so the two dots are directly comparable. Clicking a package filters the board.
import type { AgWidgetParams } from "ag-studio";
import { AgIncompleteDataMappingOverlay } from "ag-studio-react";
import { use, type MouseEvent } from "react";
import type { DeclaredVsUsedDef } from "./types.ts";

const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`;
/** A round axis: at most five steps of 1, 2, 2.5, 5 or 10 percentage points and their multiples. */
function axis(v: number) {
  const top = Math.max(v, 0.01);
  const step = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25].find((s) => top / s <= 5) ?? 0.25;
  const max = Math.ceil(top / step - 1e-9) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

export default function DeclaredVsUsed(params: AgWidgetParams<DeclaredVsUsedDef>) {
  const { widgetApi, dataMapping, format } = params;
  const style = format?.style ?? {};
  const pkg = dataMapping.package?.at(0);
  const listed = dataMapping.listed?.at(0);
  const used = dataMapping.used?.at(0);
  const sessions = dataMapping.sessions?.at(0);
  if (!pkg || !listed || !used || !sessions) return <AgIncompleteDataMappingOverlay />;

  const res = use(widgetApi.getData({ fields: [pkg, listed, used], sort: [{ field: listed, direction: "desc" }] }, { queryId: "packages" }));
  const tot = use(widgetApi.getData({ fields: [sessions] }, { queryId: "sessions" }));
  const n = Number(tot.results.rows[0]?.[sessions.key] ?? 0);

  const rows = res.results.rows
    .map((r) => ({ name: String(r[pkg.key] ?? ""), listed: n ? Number(r[listed.key] ?? 0) / n : 0, used: n ? Number(r[used.key] ?? 0) / n : 0 }))
    .filter((r) => r.name && (r.listed > 0 || r.used > 0))
    .sort((a, b) => Math.max(b.listed, b.used) - Math.max(a.listed, a.used) || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, style.maxRows ?? 10));

  const heading = style.heading ?? "Declared vs used";
  if (!rows.length) {
    return (
      <div className="ins-widget">
        <div className="ins-head"><div className="ins-title">{heading}</div></div>
        <p className="ins-empty">No package shares yet: they appear once a coding session has been reviewed.</p>
      </div>
    );
  }

  const { max, ticks } = axis(Math.max(...rows.map((r) => Math.max(r.listed, r.used))));
  const x = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const highlight = res.crossFilter ? new Set(res.crossFilter.rows.map((r) => String(r[pkg.key]))) : null;
  const selected = new Set(
    (widgetApi.getCrossFilterSelections() ?? []).flatMap((s) => (s.type === "value" ? s.values.map(String) : [])),
  );
  const toggle = (name: string, e: MouseEvent) => {
    e.stopPropagation();
    widgetApi.toggleCrossFilter({ type: "value", value: name, field: pkg, group: 0, reset: !(e.metaKey || e.ctrlKey) });
  };

  return (
    <div className="ins-widget" onClick={() => widgetApi.resetCrossFilter()}>
      <div className="ins-head">
        <div className="ins-title">{heading}</div>
        <div className="ins-legend" aria-hidden>
          <span><i className="ins-dot listed" />Dependency list (equal split)</span>
          <span><i className="ins-dot used" />Upstream (from evidence)</span>
        </div>
      </div>
      <div className="ins-axis" aria-hidden>
        <span />
        <div className="ins-ticks">
          {ticks.map((t) => <span key={t} style={{ left: `${(t / max) * 100}%` }}>{pct(t)}</span>)}
        </div>
      </div>
      <div className="ins-rows" role="list" aria-label={`${heading}: share of all session budgets in view`}>
        {rows.map((r) => {
          const never = r.listed > 0 && r.used === 0;
          const dim = highlight && !highlight.has(r.name);
          return (
            <button
              key={r.name}
              type="button"
              role="listitem"
              className={`ins-row${selected.has(r.name) ? " selected" : ""}${dim ? " dim" : ""}`}
              onClick={(e) => toggle(r.name, e)}
              aria-pressed={selected.has(r.name)}
              aria-label={`${r.name}: dependency list ${pct(r.listed)}, Upstream ${pct(r.used)}${never ? ", never used" : ""}. Click to filter the board.`}
            >
              <span className="ins-label">
                <span className="ins-name">{r.name}</span>
                {never && style.showNeverUsed !== false && <span className="ins-tag red">never used</span>}
              </span>
              <span className="ins-track">
                <span className="ins-bar" style={{ left: x(Math.min(r.listed, r.used)), width: `calc(${x(Math.max(r.listed, r.used))} - ${x(Math.min(r.listed, r.used))})` }} />
                {r.listed > 0 && <i className="ins-dot listed" style={{ left: x(r.listed) }} title={`Dependency list: ${pct(r.listed)}`} />}
                <i className={`ins-dot used${r.used === 0 ? " zero" : ""}`} style={{ left: x(r.used) }} title={`Upstream: ${pct(r.used)}`} />
              </span>
              <span className="ins-vals">
                <span className="muted">{pct(r.listed)}</span>
                <span className="ins-arrow">→</span>
                <span className={r.used === 0 ? "red" : "accent"}>{pct(r.used)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="ins-foot">Each dot is the package's share of the budgets of the {n === 1 ? "1 session" : `${n} sessions`} in view. Click a package to filter the board.</div>
    </div>
  );
}
