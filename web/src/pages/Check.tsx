import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, BadgeCheck, CircleDashed, ExternalLink, FileSearch, FileText, HandCoins, Hourglass, Info, Link2, Loader2, Sparkles, Trash2, X } from "lucide-react";
import { ApiError, api, useApi } from "../api.ts";
import { useHealth } from "../brand.tsx";
import { dateTime, moneyStr, plural } from "../format.ts";
import { describeStats, transcriptToEvents } from "../transcript.ts";
import { BrandIcon, Card, DropZone, EcoIcon, ErrorBox, EvidenceIcon, Skeleton, useCopy } from "../ui.tsx";
import { LeftoverNote, ShareBars, importanceShares, paidByRank } from "../weights.tsx";
import { PublicShell } from "./Claim.tsx";

const MANIFEST_NAME = /^(package\.json|pyproject\.toml|requirements.*\.(txt|in))$/i;
const SAMPLE_URL = "/samples/upstream-build.json";
const TAGLINE = "See which open source your agent really relied on";

export function CheckStart() {
  const nav = useNavigate();
  const { publicCheck, access, name: brand } = useHealth();
  const [manifests, setManifests] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<any>(null);

  // The sample is a real session someone reviewed and published. Without that file the button simply isn't there.
  useEffect(() => {
    let live = true;
    fetch(SAMPLE_URL)
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
      .then((s) => live && setSample(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const send = async (body: { events: unknown[]; file_name: string; stats: unknown; warnings: unknown }) => {
    try {
      const r = await api<{ id: string }>("/api/check", { body, compress: true });
      nav(`/check/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 413 ? "This session is too large to check here: it's over 10 MB even without your own files' contents. Sign in and import it from the Coding sessions page instead, which sends it in parts." : (e as Error).message);
      setBusy(null);
    }
  };

  const checkFiles = async (files: File[]) => {
    setError(null);
    setBusy("Reading your session in this browser…");
    try {
      const texts = await Promise.all(files.map((f) => f.text()));
      const ids = new Set(texts.map((t) => transcriptToEvents(t).sessionId).filter(Boolean));
      if (!ids.size) throw new Error("This doesn't look like a Claude Code session file. Look for a .jsonl file in the folder below.");
      if (ids.size > 1) throw new Error(`Those files are from ${ids.size} different sessions. Check one session at a time: its file and, if it used subagents, the files in its subagents folder.`);
      // A session's subagent files share its id, so they read as one long transcript.
      const merged = transcriptToEvents(texts.join("\n"), { manifests });
      setBusy("Sending what the review needs…");
      await send({ events: merged.events, file_name: files[0].name, stats: merged.stats, warnings: merged.warnings });
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const addManifests = async (files: File[]) => {
    setError(null);
    const bad = files.find((f) => !MANIFEST_NAME.test(f.name));
    if (bad) return setError(`${bad.name} isn't a dependency list. Add package.json, requirements.txt or pyproject.toml.`);
    const read = await Promise.all(files.map(async (f) => [f.name, await f.text()] as const));
    setManifests((m) => ({ ...m, ...Object.fromEntries(read) }));
  };

  return (
    <PublicShell wide to="/" tagline={TAGLINE}>
      <section className="stack" style={{ textAlign: "center", marginBottom: 4 }}>
        <h1 style={{ fontSize: 30 }}>Check what your AI agent really used</h1>
        <p className="muted" style={{ maxWidth: 620, margin: "0 auto" }}>A dependency list says what's installed. A coding session shows what your agent actually relied on. See the difference in about 30 seconds: no install, no sign-in, no PayPal.</p>
      </section>
      {!publicCheck && access !== null && <ErrorBox error="Public checks are turned off on this server." />}
      {error && <ErrorBox error={error} />}
      <div className="check-drop">
        <DropZone label="Drop a Claude Code session (.jsonl)" hint="Or click to choose. Add its subagent files if it has any." accept=".jsonl" disabled={Boolean(busy)} onFiles={(f) => void checkFiles(f)} />
        <div className="stack" style={{ gap: 8 }}>
          <DropZone label="Optional: add your dependency list" hint="package.json, requirements.txt or pyproject.toml. It's what the result compares against." accept=".json,.txt,.in,.toml" disabled={Boolean(busy)} onFiles={(f) => void addManifests(f)} />
          {Object.keys(manifests).length > 0 && (
            <div className="row" style={{ gap: 6 }}>
              {Object.keys(manifests).map((n) => (
                <span key={n} className="chip">
                  <FileText size={13} aria-hidden />{n}
                  <button type="button" className="btn ghost sm icon" style={{ minHeight: 20, width: 20 }} aria-label={`Remove ${n}`} onClick={() => setManifests(({ [n]: _gone, ...rest }) => rest)}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {busy && <div className="row muted" role="status"><Loader2 size={15} className="spin" />{busy}</div>}
      <div className="stack small muted" style={{ gap: 4 }}>
        <span><strong>Where is it?</strong> macOS and Linux: <code>~/.claude/projects/&lt;project&gt;/</code> · Windows: <code>%USERPROFILE%\.claude\projects\&lt;project&gt;\</code></span>
      </div>
      {sample && (
        <div className="row">
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() => {
              setError(null);
              setBusy("Sending the sample…");
              void send({ events: sample.events, file_name: sample.file_name, stats: sample.stats, warnings: sample.warnings });
            }}
          >
            <Sparkles size={15} />Use a sample: a real session from building {brand}
          </button>
        </div>
      )}
      <div className="callout">
        <Info size={16} color="var(--muted)" />
        <div className="small">
          <strong>Privacy.</strong> Your own files' contents never leave this browser, apart from the first 8 KB of source files the agent edited. Code the agent wrote, commands it ran and dependency files it read are sent to this server. File names, import lines, short code samples and install commands go to Meta's Muse Spark for the review. Secret files are never sent. Everything is deleted after 24 hours.
        </div>
      </div>
    </PublicShell>
  );
}

/** Counts up to a number once. People who asked for less motion just see the number. */
function useCountUp(target: number, ms = 900): number {
  const [value, setValue] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    // The number isn't known on the first render, so the count starts when it arrives.
    if (started.current || target === 0) return setValue(target);
    started.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setValue(target);
    const from = performance.now();
    let frame = requestAnimationFrame(function tick(t) {
      const p = Math.min((t - from) / ms, 1);
      setValue(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

const EVIDENCE_GROUPS: { icon: string; one: string; many: string; kinds?: string[]; lines?: boolean }[] = [
  { icon: "dep_install", one: "install", many: "installs", kinds: ["dep_install", "manifest_add"] },
  { icon: "import_added", one: "import", many: "imports", kinds: ["import_added"] },
  { icon: "api_usage", one: "API line", many: "API lines", lines: true },
  { icon: "source_read", one: "source read", many: "source reads", kinds: ["source_read", "source_search", "logic_reused"] },
  { icon: "docs_fetch", one: "docs lookup", many: "docs lookups", kinds: ["docs_fetch", "docs_mcp"] },
  { icon: "cli_run", one: "CLI run", many: "CLI runs", kinds: ["cli_run"] },
  { icon: "web_search", one: "web search", many: "web searches", kinds: ["web_search"] },
];

function EvidenceCounts({ c }: { c: any }) {
  const items = EVIDENCE_GROUPS.flatMap((g) => {
    const n = g.lines ? c?.usage_lines ?? 0 : (g.kinds ?? []).reduce((a, k) => a + (c?.counts?.[k] ?? 0), 0);
    return n > 0 ? [{ ...g, n }] : [];
  });
  if (!items.length) return <span className="muted small">No session evidence</span>;
  return (
    <div className="row small" style={{ gap: 12 }}>
      {items.map((g) => <span key={g.icon} className="row" style={{ gap: 4 }}><EvidenceIcon kind={g.icon} size={13} />{plural(g.n, g.one, g.many)}</span>)}
    </div>
  );
}

const AI_NOTICE: Record<string, string> = {
  paused: "The AI review is paused for today. These results come from the deterministic methods.",
  off: "The AI review isn't switched on for this server. These results come from the deterministic methods.",
  failed: "The AI review didn't finish. These results come from the deterministic methods.",
};
const METHOD_TABS = [
  { method: "llm", label: "Muse Spark" },
  { method: "baseline", label: "Import count" },
  { method: "manifest", label: "Dependency list" },
];

export function CheckResult() {
  const { id = "" } = useParams();
  const [running, setRunning] = useState(true);
  const { data, error, loading } = useApi<any>(`/api/check/${encodeURIComponent(id)}`, [id], { poll: running ? 2000 : undefined });
  const copy = useCopy();
  const { sourceUrl } = useHealth();
  const [tab, setTab] = useState<string | null>(null);
  useEffect(() => {
    if (data && data.status !== "running") setRunning(false);
  }, [data]);
  const relied = useCountUp(data?.status === "done" ? data.relied_on : 0);
  const run = useMemo(() => (data?.runs ?? []).find((r: any) => r.method === (tab ?? "llm")) ?? (tab ? null : data?.runs?.[0] ?? null), [data, tab]);
  const activeTab = tab ?? run?.method ?? "llm";

  if (error && !data) {
    return (
      <PublicShell wide to="/" tagline={TAGLINE}>
        <Card pad>
          <div className="empty" style={{ padding: 16 }}>
            <div className="icon-tile"><CircleDashed size={22} /></div>
            <h3>This check isn't here any more</h3>
            <div className="body">Checks are deleted after 24 hours, and this link may never have existed. Yours is one drop away.</div>
            <div className="row" style={{ justifyContent: "center", marginTop: 6 }}><Link className="btn primary" to="/check"><FileSearch size={15} />Check a session</Link></div>
          </div>
        </Card>
      </PublicShell>
    );
  }
  if (loading && !data) return <PublicShell wide to="/" tagline={TAGLINE}><div className="stack" role="status" aria-label="Loading"><Skeleton h={120} /><Skeleton h={240} /></div></PublicShell>;

  if (data.status === "running") {
    return (
      <PublicShell wide to="/" tagline={TAGLINE}>
        <Card pad>
          <div className="empty" style={{ padding: 20 }} role="status">
            <Loader2 size={26} className="spin" color="var(--accent)" aria-hidden />
            <h3>Going through the evidence</h3>
            <div className="body">Looking up each package and {data.ai_state === "running" ? "asking Muse Spark to weigh what the agent did" : "working out the split"}. This can take a minute for a long session, and you can leave this page open.</div>
            <div className="muted small">{describeStats(data.stats)}</div>
          </div>
        </Card>
      </PublicShell>
    );
  }
  if (data.status === "failed") {
    return (
      <PublicShell wide to="/" tagline={TAGLINE}>
        <ErrorBox error="This check didn't finish, usually because the server restarted while it ran. Your session isn't kept, so run it again." />
        <div className="row"><Link className="btn primary" to="/check"><FileSearch size={15} />Check again</Link></div>
      </PublicShell>
    );
  }

  const cands = data.candidates as any[];
  const byKey = new Map(cands.map((c) => [`${c.ecosystem}:${c.name}`, c]));
  const paid = run ? paidByRank<any>(run.weights) : [];
  const shares = importanceShares(paid);
  const present = cands.filter((c) => c.status === "present_only");
  const budget = data.example_budget;
  const hasList = data.declared > 0;

  return (
    <PublicShell wide to="/" tagline={TAGLINE}>
      <section className="check-compare" aria-label="Declared packages compared with packages the agent relied on">
        <div className={`check-count${hasList ? " dim" : " none"}`}>
          <span className="check-num">{hasList ? data.declared : "?"}</span>
          <span>{hasList ? "Declared in your dependency list" : "No dependency list was captured for this session"}</span>
          {!hasList && <Link className="small" to="/check">Add your package.json and check again</Link>}
        </div>
        <ArrowRight size={22} className="check-arrow" aria-hidden />
        <div className="check-count fill">
          <span className="check-num">{relied}</span>
          <span>Your agent relied on</span>
        </div>
      </section>

      {AI_NOTICE[data.ai_state] && <div className="callout amber"><Hourglass size={16} color="var(--amber)" /><div className="small">{AI_NOTICE[data.ai_state]}</div></div>}

      <Card
        title="Who your agent relied on"
        sub={describeStats(data.stats)}
        icon={<Sparkles size={17} />}
        tone="violet"
        actions={
          <div className="tabs" role="tablist" aria-label="Attribution method">
            {METHOD_TABS.map((t) => {
              const has = data.runs.some((r: any) => r.method === t.method);
              return <button key={t.method} role="tab" aria-selected={activeTab === t.method} className="tab" disabled={!has} title={has ? undefined : t.method === "manifest" ? "No dependency list was captured for this session." : "This method didn't run for this check."} onClick={() => setTab(t.method)}>{t.label}</button>;
            })}
          </div>
        }
      >
        {run?.method === "manifest" && <div className="callout" style={{ marginBottom: 12 }}><Info size={16} color="var(--muted)" /><div className="small">Every declared package gets the same share, used or not. This approximates manifest-based funding. It is not thanks.dev's exact algorithm.</div></div>}
        {!paid.length ? (
          <p className="muted">No package earned a share with this method. Nothing in the session showed real use.</p>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            {paid.map((w: any) => {
              const c = byKey.get(`${w.ecosystem}:${w.name}`);
              const m = c?.repo ? data.maintainers[c.repo] : null;
              return (
                <div key={`${w.ecosystem}:${w.name}`} className="card flat" style={{ padding: 14 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <EcoIcon ecosystem={w.ecosystem} />
                    <strong>{w.name}</strong>
                    <div className="spacer" />
                    {m ? (
                      <Link className={`pill ${m.status === "verified" ? "green" : "amber"}`} to={m.link}>
                        {m.status === "verified" ? <BadgeCheck size={12} /> : <span className="dot" />}
                        Maintainer: {m.status === "verified" ? "Verified" : "Unclaimed"}
                      </Link>
                    ) : <span className="pill outline">Repo not found</span>}
                  </div>
                  <ShareBars method={run.method} row={w} shares={shares} />
                  <EvidenceCounts c={c} />
                </div>
              );
            })}
          </div>
        )}
        {run && <div style={{ marginTop: 12 }}><LeftoverNote flags={run.flags} unallocated={run.unallocated} maxShare={data.max_package_share} paid={paid.length} /></div>}
        {present.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary className="small" style={{ cursor: "pointer", fontWeight: 560 }}>Merely present: {plural(present.length, "package")}, {run?.method === "manifest" ? "and this method pays them anyway" : "never paid"}</summary>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              {present.map((c) => <span key={c.name} className="chip"><EcoIcon ecosystem={c.ecosystem} size={13} />{c.name}</span>)}
            </div>
          </details>
        )}
      </Card>

      {paid.length > 0 && (
        <Card title={`Example split of a ${moneyStr(budget.amount, budget.currency)} budget`} sub="An example with this method's shares. Nothing here is paid." icon={<HandCoins size={17} />} tone="teal">
          <p>
            {paid.map((w: any, i: number) => (
              <span key={`${w.ecosystem}:${w.name}`}>
                {i > 0 && <span className="muted"> · </span>}
                {w.name} <strong className="num">{moneyStr((w.weight * Number(budget.amount)).toFixed(2), budget.currency)}</strong>
              </span>
            ))}
            {run.unallocated > 0.0001 && <><span className="muted"> · stays in your pool </span><strong className="num">{moneyStr((run.unallocated * Number(budget.amount)).toFixed(2), budget.currency)}</strong></>}
          </p>
        </Card>
      )}

      {data.warnings.length > 0 && (
        <div className="callout">
          <Info size={16} color="var(--muted)" />
          <div className="small muted stack" style={{ gap: 4 }}>{data.warnings.map((w: string) => <span key={w}>{w}</span>)}</div>
        </div>
      )}
      {run?.flags?.some((f: any) => f.level !== "info") && (
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>What code checked in this method's proposal</summary>
          <div className="stack small muted" style={{ gap: 4, marginTop: 8 }}>{run.flags.filter((f: any) => f.level !== "info").map((f: any, i: number) => <span key={i}><code>{f.code}</code> {f.message}</span>)}</div>
        </details>
      )}

      <div className="row">
        <button className="btn" onClick={() => void copy(window.location.href, "Link copied. It stops working after 24 hours.")}><Link2 size={15} />Copy link (valid 24 h)</button>
        {sourceUrl && <a className="btn primary" href={`${sourceUrl}#run-it-locally`} target="_blank" rel="noreferrer"><BrandIcon name="paypal" size={15} mono />Fund these maintainers<ExternalLink size={13} /></a>}
        <div className="spacer" />
        <Link className="btn ghost" to="/check"><FileSearch size={15} />Check another session</Link>
        <span className="muted small row" style={{ gap: 4 }}><Trash2 size={12} aria-hidden />Deleted {dateTime(data.expires_at)}</span>
      </div>
    </PublicShell>
  );
}
