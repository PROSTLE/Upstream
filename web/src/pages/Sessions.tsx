import { useNavigate } from "react-router-dom";
import { TerminalSquare } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { useApi } from "../api.ts";
import { dateTime, duration } from "../format.ts";
import { Card, Empty, ErrorBox, Loading, PackageChip, PageHead, Status } from "../ui.tsx";
import { Grid } from "../data.tsx";
import { Link } from "react-router-dom";

export function Sessions() {
  const { data, error, loading } = useApi<any[]>("/api/sessions");
  const nav = useNavigate();
  const cols: ColDef<any>[] = [
    { headerName: "Project", field: "project", minWidth: 160, cellRenderer: (p: any) => <strong>{p.value ?? "unknown"}</strong> },
    { headerName: "Status", field: "status", maxWidth: 140, cellRenderer: (p: any) => <Status value={p.value} /> },
    { headerName: "Started", field: "started_at", valueFormatter: (p) => dateTime(p.value), sort: "desc", maxWidth: 160 },
    { headerName: "Length", valueGetter: (p) => duration(p.data.started_at, p.data.ended_at ?? p.data.last_event_at), maxWidth: 110 },
    { headerName: "Tool events", field: "event_count", maxWidth: 120, type: "numericColumn" },
    { headerName: "Evidence", field: "evidence_count", maxWidth: 110, type: "numericColumn" },
    {
      headerName: "Attributed to",
      field: "top",
      flex: 2,
      minWidth: 280,
      sortable: false,
      filter: false,
      cellRenderer: (p: any) => (
        <div className="row" style={{ gap: 6, height: "100%" }}>
          {p.value?.length ? p.value.map((t: any) => <PackageChip key={t.name} ecosystem={t.ecosystem} name={t.name} weight={t.weight} />) : <span className="faint">—</span>}
        </div>
      ),
    },
    { headerName: "Method", field: "method", maxWidth: 120, valueFormatter: (p) => (p.value === "llm" ? "Claude" : p.value === "baseline" ? "Baseline" : "—") },
  ];
  return (
    <div className="page">
      <PageHead title="Agent sessions" subtitle="One row per Claude Code session. Evidence comes from PostToolUse hooks: installs, imports written, APIs used, library source read, docs fetched." />
      {error && <ErrorBox error={error} />}
      <Card>
        {loading && !data ? <Loading /> : !data?.length ? (
          <Empty icon={<TerminalSquare size={22} />} title="No sessions yet">
            Install the hook from <Link to="/connect">Connect your agent</Link>, then code as usual.
          </Empty>
        ) : (
          <Grid rows={data} columns={cols} height={560} onRowClick={(r) => nav(`/sessions/${r.id}`)} getRowId={(r) => r.id} />
        )}
      </Card>
    </div>
  );
}
