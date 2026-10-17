import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, Braces, CheckCircle2, CircleSlash, FileWarning, Flag, FlaskConical, Info, Layers, ListTree, Scale, Sparkles, X,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { dateTime, duration, pct } from "../format.ts";
import { ActionButton, BrandIcon, Card, EVIDENCE, EcoIcon, Empty, ErrorBox, EvidenceIcon, Loading, PageHead, Status, useToast } from "../ui.tsx";
import { Chart } from "../data.tsx";

export function SessionDetail() {
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/api/sessions/${encodeURIComponent(id)}`, [id]);
  const toast = useToast();
  const [tabSel, setTab] = useState<"llm" | "baseline" | null>(null);
  const [raw, setRaw] = useState<any>(null);

  const runs = data?.runs ?? [];
  const llm = runs.find((r: any) => r.method === "llm");
  const base = runs.find((r: any) => r.method === "baseline");
  const tab = tabSel ?? (llm || !base ? "llm" : "baseline");
  const shown = tab === "llm" ? llm : base;
  const set = data?.candidates;
  const evById = useMemo(() => new Map((set?.evidence ?? []).map((e: any) => [e.id, e])), [set]);

  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorBox error={error ?? "Session not found"} /></div>;
  const s = data.session;
  const cands = set.candidates as any[];
  const used = cands.filter((c) => c.status === "used");
  const consulted = cands.filter((c) => c.status === "consulted");
  const present = cands.filter((c) => c.status === "present_only");

  const compareKeys = [...new Set([...(llm?.validated.weights ?? []), ...(base?.validated.weights ?? [])].filter((w: any) => w.weight > 0).map((w: any) => w.name))];
  const weightOf = (run: any, name: string) => run?.validated.weights.find((w: any) => w.name === name)?.weight ?? 0;

  return (
    <div className="page">
      <Link to="/sessions" className="row muted small" style={{ gap: 6 }}><ArrowLeft size={14} />All sessions</Link>
      <PageHead
        title={<span className="row" style={{ gap: 10 }}>{s.project ?? "Session"} <Status value={s.status} /></span>}
        subtitle={<>Started {dateTime(s.started_at)} · {duration(s.started_at, s.ended_at ?? s.last_event_at)} · {data.events.length} tool events · <code>{s.id}</code></>}
        actions={
          <>
            {s.status === "open" && (
              <ActionButton onRun={async () => { await api(`/api/sessions/${id}/close`, { body: {}, admin: true }); await reload(); }}>
                Close session
              </ActionButton>
            )}
            <ActionButton
              className="btn primary"
              disabled={Boolean(s.allocated_settlement_id)}
              title={s.allocated_settlement_id ? "Already part of a payout" : undefined}
              onRun={async () => {
                const r = await api<any>(`/api/sessions/${id}/attribute`, { body: {}, admin: true });
                if (r.llmError) toast(`Baseline saved. Claude attribution failed: ${r.llmError}`, "error");
                else toast("Attribution complete and validated.");
                await reload();
              }}
            >
              <BrandIcon name="claude" size={15} mono />
              {llm ? "Re-run attribution" : "Attribute with Claude"}
            </ActionButton>
          </>
        }
      />

      <div className="grid-4">
        <MiniStat icon={<Layers size={15} />} label="Evidence records" value={set.evidence.length + set.unattributed.length} />
        <MiniStat icon={<CheckCircle2 size={15} />} tone="green" label="Packages used" value={used.length} />
        <MiniStat icon={<Info size={15} />} tone="amber" label="Docs only" value={consulted.length} />
        <MiniStat icon={<CircleSlash size={15} />} label="Merely present" value={present.length} foot="In the manifest, no session evidence: never paid" />
      </div>

      <Card
        title="Attribution"
        sub={shown ? `${shown.method === "llm" ? `Claude (${shown.model})` : "Import-count baseline"} · validated ${dateTime(shown.created_at)}${shown.is_active ? " · used for payouts" : ""}` : "Not attributed yet"}
        icon={<Scale size={17} />}
        actions={
          <div className="row">
            <div className="tabs">
              <button className={`tab ${tab === "llm" ? "active" : ""}`} onClick={() => setTab("llm")}>Claude</button>
              <button className={`tab ${tab === "baseline" ? "active" : ""}`} onClick={() => setTab("baseline")}>Baseline</button>
            </div>
            {shown && !shown.is_active && !s.allocated_settlement_id && (
              <ActionButton className="btn sm" onRun={async () => { await api(`/api/sessions/${id}/active-run`, { body: { run_id: shown.id }, admin: true }); toast("This attribution will be used for payouts."); await reload(); }}>
                Use for payouts
              </ActionButton>
            )}
          </div>
        }
      >
        {!shown ? (
          <Empty icon={<Sparkles size={22} />} title={tab === "llm" ? "No Claude attribution yet" : "No baseline yet"}>
            Run attribution: Claude reads the evidence below and proposes weights with citations; code then drops anything uncited, hallucinated or merely present, and enforces the per-package cap from your policy.
            {runs.length === 0 && cands.length > 0 && (
              <> For the eval, label packages in “Your ground truth” first: labels saved before any attribution runs count as blind.</>
            )}
          </Empty>
        ) : (
          <div className="grid-2" style={{ alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {shown.validated.weights.map((w: any) => (
                <div key={w.name} className="card" style={{ padding: 14, boxShadow: "none" }}>
                  <div className="row" style={{ gap: 8 }}>
                    <EcoIcon ecosystem={w.ecosystem} />
                    <strong>{w.name}</strong>
                    <Status value={w.classification} />
                    <div className="spacer" />
                    <span className="num" style={{ fontWeight: 650 }}>{pct(w.weight, 1)}</span>
                  </div>
                  <div className={`bar ${w.weight === 0 ? "muted" : ""}`} style={{ margin: "10px 0" }}><span style={{ width: `${Math.max(w.weight * 100, w.weight > 0 ? 2 : 0)}%` }} /></div>
                  {w.rationale && <p className="small" style={{ color: "var(--text-2)" }}>{w.rationale}</p>}
                  {w.evidence_ids.length > 0 && (
                    <div className="row" style={{ gap: 6, marginTop: 8 }}>
                      {w.evidence_ids.slice(0, 8).map((eid: string) => {
                        const e: any = evById.get(eid);
                        return (
                          <span key={eid} className="chip" title={eid}>
                            <EvidenceIcon kind={e?.kind ?? ""} size={13} />
                            {EVIDENCE[e?.kind]?.label ?? eid}
                          </span>
                        );
                      })}
                      {w.evidence_ids.length > 8 && <span className="muted small">+{w.evidence_ids.length - 8} more</span>}
                    </div>
                  )}
                  {w.proposed_weight !== undefined && shown.method === "llm" && w.weight === 0 && w.proposed_weight > 0 && (
                    <div className="small" style={{ color: "var(--red)", marginTop: 6 }}>Proposed {w.proposed_weight}, zeroed by the validator.</div>
                  )}
                </div>
              ))}
              {shown.validated.unallocated > 0.0001 && (
                <div className="callout"><Info size={16} color="var(--muted)" /><div className="small">{pct(shown.validated.unallocated, 1)} of this session's budget stays in the pool (per-package cap or nothing qualified).</div></div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {compareKeys.length > 0 && llm && base && (
                <div className="card" style={{ padding: 12, boxShadow: "none" }}>
                  <div className="row" style={{ padding: "2px 4px 6px" }}><FlaskConical size={15} color="var(--violet)" /><h3>Claude vs import-count baseline</h3></div>
                  <Chart
                    height={Math.max(180, compareKeys.length * 46)}
                    options={{
                      data: compareKeys.map((k) => ({ pkg: k, claude: +(weightOf(llm, k) * 100).toFixed(1), baseline: +(weightOf(base, k) * 100).toFixed(1) })),
                      series: [
                        { type: "bar", direction: "horizontal", xKey: "pkg", yKey: "claude", yName: "Claude", cornerRadius: 4 },
                        { type: "bar", direction: "horizontal", xKey: "pkg", yKey: "baseline", yName: "Baseline", cornerRadius: 4, fill: "#c9ccd6", stroke: "#c9ccd6" },
                      ],
                      axes: { x: { type: "category" }, y: { type: "number", label: { formatter: ({ value }: any) => `${value}%` } } },
                      legend: { position: "bottom" },
                    } as any}
                  />
                </div>
              )}
              <div>
                <div className="row" style={{ marginBottom: 6 }}><Flag size={15} color="var(--muted)" /><h3>Validator flags</h3></div>
                {shown.flags.length === 0 ? <p className="muted small">No flags.</p> : shown.flags.map((f: any, i: number) => (
                  <div key={i} className="check">
                    {f.level === "error" ? <AlertTriangle size={16} color="var(--red)" /> : f.level === "warn" ? <FileWarning size={16} color="var(--amber)" /> : <Info size={16} color="var(--muted)" />}
                    <div className="small"><code>{f.code}</code> {f.message}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      <div className="split">
        <Card title="Evidence timeline" sub="Deterministic records extracted from hook payloads" icon={<ListTree size={17} />} tone="teal">
          {set.evidence.length === 0 ? <Empty icon={<ListTree size={22} />} title="No linked evidence" /> : (
            <div className="timeline" style={{ maxHeight: 620, overflow: "auto", paddingRight: 6 }}>
              {dedupeById(set.evidence).map((e: any) => (
                <div key={e.id + e.package} className="tl-item">
                  <div className="tl-icon"><EvidenceIcon kind={e.kind} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <strong style={{ fontWeight: 580 }}>{EVIDENCE[e.kind]?.label ?? e.kind}</strong>
                      <span className="chip"><EcoIcon ecosystem={e.ecosystem} size={12} />{e.package}</span>
                      <span className={`pill ${e.strength === "strong" ? "green" : e.strength === "moderate" ? "blue" : ""}`}>{e.strength}</span>
                      {e.link !== "direct" && <span className="pill outline" title="How this evidence was linked to the package">via {e.link.replace(/_/g, " ")}</span>}
                    </div>
                    <div className="muted small" style={{ marginTop: 3, overflowWrap: "anywhere" }}>{describe(e, s.cwd)}</div>
                    <button className="btn ghost sm" style={{ marginTop: 2, paddingLeft: 0 }} onClick={async () => setRaw(await api(`/api/sessions/${id}/events/${e.id.split("_")[1]}`))}>
                      <Braces size={13} />Raw hook payload
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {set.unattributed.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="muted small" style={{ cursor: "pointer" }}>{set.unattributed.length} record(s) not linked to any package</summary>
              {set.unattributed.map((u: any) => (
                <div key={u.id} className="check small"><EvidenceIcon kind={u.kind} size={14} /><div><code>{u.id}</code> {u.reason}</div></div>
              ))}
            </details>
          )}
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card title="Candidates" sub="Every package with evidence or a manifest entry" icon={<Layers size={17} />}>
            {cands.length === 0 ? <p className="muted">No candidates.</p> : (
              <div className="list" style={{ margin: "-16px -20px -20px" }}>
                {cands.map((c) => (
                  <div key={c.ecosystem + c.name} className="list-item">
                    <EcoIcon ecosystem={c.ecosystem} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <strong>{c.name}</strong>
                        <Status value={c.status} label={c.status === "present_only" ? "Merely present" : undefined} />
                        {c.added_in_session && <span className="pill teal">added this session</span>}
                      </div>
                      <div className="row small muted" style={{ gap: 10, marginTop: 4 }}>
                        {Object.entries(c.counts).map(([k, n]) => (
                          <span key={k} className="row" style={{ gap: 4 }}><EvidenceIcon kind={k} size={12} />{n as number}</span>
                        ))}
                        {c.repo ? <span className="row" style={{ gap: 4 }}><BrandIcon name="github" size={12} mono />{c.repo.replace("github.com/", "")}</span> : <span>repo not resolved yet</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <LabelEditor sessionId={id} candidates={cands} labels={data.labels} blind={data.labels_blind} attributed={runs.length > 0} onSaved={reload} />
        </div>
      </div>

      {raw && (
        <div className="modal-back" onClick={() => setRaw(null)}>
          <div className="modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <div className="icon-tile"><Braces size={17} /></div>
              <div><h2>{raw.hook_event_name} · {raw.tool_name}</h2><div className="sub">Exactly what the hook sent (secret files redacted on your machine)</div></div>
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => setRaw(null)}><X size={16} /></button>
            </div>
            <div className="card-body"><pre className="json">{JSON.stringify(raw.payload, null, 2)}</pre></div>
          </div>
        </div>
      )}
    </div>
  );
}

function dedupeById(list: any[]) {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = `${e.id}|${e.package}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function describe(e: any, cwd?: string | null): string {
  const d = e.detail ?? {};
  const rel = (p: string) => {
    const norm = (x: string) => x.replace(/\\/g, "/");
    const base = cwd ? norm(cwd).replace(/\/+$/, "") + "/" : "";
    const n = norm(p);
    return base && n.toLowerCase().startsWith(base.toLowerCase()) ? n.slice(base.length) : n;
  };
  if (d.command) return d.command;
  if (d.url) return d.url;
  if (d.query) return `“${d.query}”`;
  if (d.libraryId || d.libraryName) return `${d.libraryId || d.libraryName}${d.query ? ` — ${d.query}` : ""}`;
  if (d.path) return rel(d.path);
  if (d.file) {
    const lines = d.usage_lines != null ? ` · ${d.usage_lines} line(s) using ${(d.bindings ?? []).join(", ") || "it"}` : "";
    return `${rel(d.file)}${lines}${d.type_only ? " · type-only" : ""}`;
  }
  return "";
}

function MiniStat({ icon, label, value, tone, foot }: { icon: React.ReactNode; label: string; value: number; tone?: string; foot?: string }) {
  return (
    <div className="card stat" style={{ padding: 16 }}>
      <div className="stat-label"><div className={`icon-tile ${tone ?? ""}`} style={{ width: 26, height: 26, borderRadius: 8 }}>{icon}</div>{label}</div>
      <div className="stat-value" style={{ fontSize: 24 }}>{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

function LabelEditor({ sessionId, candidates, labels, blind, attributed, onSaved }: { sessionId: string; candidates: any[]; labels: any[]; blind: boolean; attributed: boolean; onSaved: () => void }) {
  const initial = Object.fromEntries(labels.map((l) => [`${l.ecosystem}:${l.package}`, l.label]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const toast = useToast();
  if (!candidates.length) return null;
  return (
    <Card title="Your ground truth" sub="Label packages to score Claude against the baseline on the Eval page" icon={<FlaskConical size={17} />} tone="violet">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {candidates.map((c) => {
          const k = `${c.ecosystem}:${c.name}`;
          return (
            <div key={k} className="row" style={{ gap: 8 }}>
              <EcoIcon ecosystem={c.ecosystem} size={14} />
              <span style={{ flex: 1, minWidth: 0 }}>{c.name}</span>
              <select className="input" style={{ width: 170, height: 32 }} value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                <option value="">Not labelled</option>
                <option value="meaningful">Meaningful</option>
                <option value="incidental">Incidental</option>
                <option value="not_used">Not used</option>
              </select>
            </div>
          );
        })}
      </div>
      <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
        <span className="muted small" style={{ flex: 1 }}>
          {labels.length === 0
            ? attributed
              ? "Attribution already ran, so labels saved now count as not blind."
              : "Label before attributing to keep these labels blind."
            : blind
              ? "Blind: saved before any attribution ran."
              : "Not blind: saved or changed after attribution ran."}
        </span>
        <ActionButton
          className="btn"
          onRun={async () => {
            const payload = Object.entries(values).filter(([, v]) => v).map(([k, label]) => {
              const [ecosystem, ...rest] = k.split(":");
              return { ecosystem, package: rest.join(":"), label };
            });
            const r = await api<any>(`/api/sessions/${sessionId}/labels`, { method: "PUT", body: { labels: payload }, admin: true });
            toast(`Saved ${payload.length} label(s)${payload.length ? (r.blind ? " (blind)" : " (not blind)") : ""}.`);
            onSaved();
          }}
        >
          Save labels
        </ActionButton>
      </div>
    </Card>
  );
}
