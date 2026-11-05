import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlugZap, Search, TerminalSquare } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { useApi } from "../api.ts";
import { ago, dateTime, duration } from "../format.ts";
import { Card, Empty, ErrorBox, Loading, PackageChip, PageHead, Status } from "../ui.tsx";
import { Grid } from "../data.tsx";

const FILTERS = [
  { v: "all", label: "All" },
  { v: "todo", label: "Needs attribution" },
  { v: "attributed", label: "Reviewed" },
  { v: "open", label: "Live" },
] as const;

export function Sessions() {
  const { data, error, loading, updatedAt } = useApi<any[]>("/api/sessions", [], { poll: 10000 });
  const nav = useNavigate();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["v"]>("all");
  const [q, setQ] = useState("");
  const counts = useMemo(() => ({
    all: data?.length ?? 0,
    todo: data?.filter((s) => s.status !== "attributed").length ?? 0,
    attributed: data?.filter((s) => s.status === "attributed").length ?? 0,
    open: data?.filter((s) => s.status === "open").length ?? 0,
  }), [data]);
  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return (data ?? []).filter((s) =>
      (filter === "all" || (filter === "todo" ? s.status !== "attributed" : s.status === filter)) &&
      (!qq || `${s.project ?? ""} ${s.id} ${s.top.map((t: any) => t.name).join(" ")}`.toLowerCase().includes(qq)));
  }, [data, filter, q]);

  const cols: ColDef<any>[] = [
    { headerName: "Project", field: "project", minWidth: 160, cellRenderer: (p: any) => <strong>{p.value ?? "unknown"}</strong> },
    { headerName: "Status", field: "status", maxWidth: 140, cellRenderer: (p: any) => <Status value={p.value} live={p.value === "open"} /> },
    { headerName: "Started", field: "started_at", valueFormatter: (p) => dateTime(p.value), sort: "desc", maxWidth: 160 },
    { headerName: "Length", valueGetter: (p) => duration(p.data.started_at, p.data.ended_at ?? p.data.last_event_at), maxWidth: 110 },
    { headerName: "Tool events", field: "event_count", maxWidth: 120, type: "numericColumn" },
    { headerName: "Evidence", field: "evidence_count", maxWidth: 110, type: "numericColumn" },
    {
      headerName: "Credited packages",
      field: "top",
      flex: 2,
      minWidth: 280,
      sortable: false,
      filter: false,
      cellRenderer: (p: any) => (
        <div className="row" style={{ gap: 6, height: "100%" }}>
          {p.value?.length ? p.value.map((t: any) => <PackageChip key={t.name} ecosystem={t.ecosystem} name={t.name} weight={t.weight} />) : <span className="faint">Not attributed yet</span>}
        </div>
      ),
    },
    { headerName: "Method", field: "method", maxWidth: 120, valueFormatter: (p) => (p.value === "llm" ? "Muse Spark" : p.value === "baseline" ? "Baseline" : "—") },
  ];
  return (
    <div className="page">
      <PageHead
        eyebrow="Step 2"
        title="Coding sessions"
        subtitle="Each row is one Claude Code session, showing what the agent actually did: packages installed, code written with them, library source read and docs opened."
        actions={<span className="muted small">{updatedAt ? `Updated ${ago(new Date(updatedAt).toISOString())} · live` : ""}</span>}
      />
      {error && <ErrorBox error={error} />}
      {loading && !data ? <Loading rows={1} /> : !data?.length ? (
        <Card>
          <Empty icon={<TerminalSquare size={22} />} title="No sessions yet" action={<Link className="btn primary" to="/connect"><PlugZap size={15} />Connect your agent</Link>}>
            Connect Claude Code to a project, then code as usual. Sessions appear here while they run.
          </Empty>
        </Card>
      ) : (
        <Card>
          <div className="row" style={{ marginBottom: 12, gap: 12 }}>
            <div className="tabs" role="tablist" aria-label="Filter sessions">
              {FILTERS.map((f) => (
                <button key={f.v} role="tab" aria-selected={filter === f.v} className="tab" onClick={() => setFilter(f.v)}>
                  {f.label}<span className="faint num">{counts[f.v]}</span>
                </button>
              ))}
            </div>
            <div className="spacer" />
            <label className="row" style={{ gap: 0, position: "relative", minWidth: 220, flex: "0 1 300px" }}>
              <span className="sr-only">Search sessions</span>
              <Search size={15} style={{ position: "absolute", left: 11, color: "var(--faint)" }} />
              <input className="input" style={{ paddingLeft: 34, minHeight: 36 }} placeholder="Project, package or id" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>
          <Grid rows={rows} columns={cols} height={560} onRowClick={(r) => nav(`/sessions/${r.id}`)} getRowId={(r) => r.id} empty="No sessions match this filter" />
        </Card>
      )}
    </div>
  );
}
