import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileUp, Info, Loader2, PlugZap, Search, TerminalSquare } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { api, useApi } from "../api.ts";
import { ago, dateTime, duration, plural } from "../format.ts";
import { chunkEvents, describeStats, transcriptToEvents } from "../transcript.ts";
import { useBrand } from "../brand.tsx";
import { Card, DropZone, Empty, ErrorBox, Loading, Modal, PackageChip, PageHead, Status } from "../ui.tsx";
import { Grid } from "../data.tsx";

// The server accepts 10 MB per request; a long session is sent in several requests.
const UPLOAD_CHUNK_BYTES = 8_000_000;

type ImportRow = { name: string; state: "working" | "done" | "failed"; summary?: string; warnings: string[]; stored?: number; evidence?: number; sessionId?: string; error?: string };

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const brand = useBrand();
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState(false);

  const importFiles = async (files: File[]) => {
    setBusy(true);
    for (const file of files) {
      const update = (patch: Partial<ImportRow>) => setRows((all) => all.map((r) => (r.name === file.name ? { ...r, ...patch } : r)));
      setRows((all) => [...all.filter((r) => r.name !== file.name), { name: file.name, state: "working", warnings: [] }]);
      try {
        const converted = transcriptToEvents(await file.text());
        update({ summary: describeStats(converted.stats), warnings: converted.warnings });
        if (!converted.sessionId) throw new Error("This doesn't look like a Claude Code session file.");
        let stored = 0;
        let evidence = 0;
        let sessionId = "";
        for (const events of chunkEvents(converted.events, UPLOAD_CHUNK_BYTES)) {
          const r = await api<{ session_id: string; stored: number; evidence: number }>("/api/sessions/import", { body: { file_name: file.name, events }, admin: true, compress: true });
          stored += r.stored;
          evidence += r.evidence;
          sessionId = r.session_id;
        }
        update({ state: "done", stored, evidence, sessionId });
        onImported();
      } catch (e) {
        update({ state: "failed", error: (e as Error).message });
      }
    }
    setBusy(false);
  };

  return (
    <Modal width={640} title="Import past sessions" sub="See who your agent relied on before you installed anything" icon={<FileUp size={17} />} onClose={onClose}>
      <div className="stack">
        <DropZone label="Drop Claude Code session files here, or click to choose" hint="One .jsonl file per session" accept=".jsonl" disabled={busy} onFiles={(f) => void importFiles(f)} />
        <div className="small muted stack" style={{ gap: 4 }}>
          <span><strong>Where to find them.</strong> macOS and Linux: <code>~/.claude/projects/&lt;project&gt;/</code> · Windows: <code>%USERPROFILE%\.claude\projects\&lt;project&gt;\</code></span>
          <span>Work done by subagents is in <code>&lt;session&gt;/subagents/</code> next to the session file. Add those files too; they join the same session.</span>
        </div>
        <div className="callout">
          <Info size={16} color="var(--muted)" />
          <div className="small">Your own files' contents stay in this browser, apart from the first 8 KB of source files the agent edited. Code the agent wrote, commands it ran and dependency files it read are sent to your {brand} server. Secret files are never sent.</div>
        </div>
        {rows.length > 0 && (
          <div className="summary">
            {rows.map((r) => (
              <div key={r.name} className="line-row" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    {r.state === "working" && <Loader2 size={13} className="spin" aria-label="Importing" />}
                    <strong style={{ overflowWrap: "anywhere" }}>{r.name}</strong>
                  </div>
                  {r.summary && <div className="muted small">{r.summary}</div>}
                  {r.state === "done" && <div className="muted small">{r.stored ? `${plural(r.stored!, "new record")}, ${plural(r.evidence!, "piece")} of evidence` : "Nothing new: this session was already here."}</div>}
                  {r.warnings.map((w) => <div key={w} className="small" style={{ color: "var(--amber)" }}>{w}</div>)}
                  {r.error && <div className="small" style={{ color: "var(--red)" }} role="alert">{r.error}</div>}
                </div>
                {r.sessionId && <Link className="btn sm" style={{ flex: "none" }} to={`/sessions/${encodeURIComponent(r.sessionId)}`}>Open session</Link>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

const FILTERS = [
  { v: "all", label: "All" },
  { v: "todo", label: "Needs attribution" },
  { v: "attributed", label: "Reviewed" },
  { v: "open", label: "Live" },
] as const;

export function Sessions() {
  const { data, error, loading, updatedAt, reload } = useApi<any[]>("/api/sessions", [], { poll: 10000 });
  const nav = useNavigate();
  const [importing, setImporting] = useState(false);
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
    {
      headerName: "Project",
      field: "project",
      minWidth: 200,
      cellRenderer: (p: any) => (
        <span className="row" style={{ gap: 8 }}>
          <strong>{p.value ?? "unknown"}</strong>
          {p.data.source === "transcript" && <span className="pill violet" title="Imported from a Claude Code session file">Imported</span>}
        </span>
      ),
    },
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
        actions={
          <>
            <span className="muted small">{updatedAt ? `Updated ${ago(new Date(updatedAt).toISOString())} · live` : ""}</span>
            <button className="btn" onClick={() => setImporting(true)}><FileUp size={15} />Import past sessions</button>
          </>
        }
      />
      {importing && <ImportModal onClose={() => setImporting(false)} onImported={() => void reload()} />}
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
