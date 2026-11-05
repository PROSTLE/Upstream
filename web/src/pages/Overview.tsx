import { Link } from "react-router-dom";
import {
  ArrowRight, CircleDollarSign, ListChecks, PartyPopper, PlugZap, TerminalSquare,
} from "lucide-react";
import { useApi } from "../api.ts";
import { ago, money } from "../format.ts";
import { setupSteps, useOverview } from "../overview.tsx";
import { CheckRow, CodeBlock, Card, Empty, ErrorBox, Loading, PackageChip, PageHead, Status } from "../ui.tsx";

export function Overview() {
  const { data, error } = useOverview();
  const sessions = useApi<any[]>("/api/sessions", [], { poll: 10000 });
  if (error && !data) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <div className="page"><Loading /></div>;
  const p = data.pool;
  const cur = p.currency;
  const steps = setupSteps(data);
  const done = steps.filter((s) => s.ok).length;
  const next = steps.find((s) => !s.ok);
  const c = data.counts;

  return (
    <div className="page">
      <PageHead
        title="Your open-source giving"
        subtitle={`See which packages your AI agent really relied on, then pay the people who maintain them.`}
      />

      <NextStep done={done} total={steps.length} next={next} />

      <section className="card" aria-label="Money flow">
        <div className="pipeline">
          <Pipe n={1} to="/funding" label="Funded" value={money(p.fundingGross, cur)} foot={`PayPal fees ${money(-p.fundingFees, cur)}`} />
          <Pipe n={2} to="/sessions" label="Coding sessions" value={String(c.sessions)} foot={c.sessions ? `${c.evidence} evidence records` : "Nothing recorded yet"} />
          <Pipe n={3} to="/sessions" label="Reviewed by AI" value={String(c.attributed)} foot={c.sessions - c.attributed > 0 ? `${c.sessions - c.attributed} waiting for review` : "All caught up"} />
          <Pipe n={4} to="/packages" label="Verified maintainers" value={String(c.verified_claims)} foot={`${money(p.reserved, cur)} held for unclaimed repos`} />
          <Pipe n={5} to="/ledger" label="Paid to maintainers" value={money(-p.payoutsSent - p.returned, cur)} foot={`Available now ${money(p.available, cur)}`} />
        </div>
      </section>

      <div className="split">
        <Card title="Where the money goes" sub="Every number comes from PayPal-confirmed ledger entries" icon={<CircleDollarSign size={17} />}>
          {p.fundingGross === 0 ? (
            <Empty icon={<CircleDollarSign size={22} />} title="No funds yet" action={<Link className="btn" to="/funding">Add funds</Link>}>
              Approve your monthly budget once in PayPal. The first subscription payment shows here when PayPal confirms it, with PayPal's fee split out.
            </Empty>
          ) : (
            <FlowDiagram pool={p} />
          )}
        </Card>
        <Card title="Setup checklist" sub={`${done} of ${steps.length} done`} icon={<ListChecks size={17} />} tone="violet">
          {steps.map((s) => <CheckRow key={s.id} ok={s.ok} label={s.label} detail={s.ok ? s.detail : undefined} />)}
        </Card>
      </div>

      <div>
        <Card
          title="Recent coding sessions"
          sub={<span className="row" style={{ gap: 6 }}><span className="pill green live" style={{ height: 18 }}><span className="dot" />Live</span>refreshes every 10 s</span>}
          icon={<TerminalSquare size={17} />}
          actions={<Link className="btn ghost sm" to="/sessions">All sessions <ArrowRight size={14} /></Link>}
        >
          {!sessions.data?.length ? (
            <Empty icon={<TerminalSquare size={22} />} title="No sessions recorded" action={<Link className="btn" to="/connect"><PlugZap size={15} />Connect your agent</Link>}>
              Connect your agent and code as usual. What it uses shows up here within seconds.
            </Empty>
          ) : (
            <div className="list flush">
              {sessions.data.slice(0, 6).map((s) => (
                <Link key={s.id} to={`/sessions/${s.id}`} className="list-item">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{s.project ?? "unknown project"}</strong>
                      <Status value={s.status} live={s.status === "open"} />
                    </div>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      {s.top.length ? s.top.map((t: any) => <PackageChip key={t.name} ecosystem={t.ecosystem} name={t.name} weight={t.weight} />) : <span className="muted small">{s.evidence_count} evidence records · not attributed yet</span>}
                    </div>
                  </div>
                  <span className="muted small" style={{ flex: "none" }}>{ago(s.last_event_at)}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function NextStep({ done, total, next }: { done: number; total: number; next?: ReturnType<typeof setupSteps>[number] }) {
  const r = 26, C = 2 * Math.PI * r;
  return (
    <section className="hero" aria-label="Next step">
      <svg className="progress-ring" width="68" height="68" viewBox="0 0 68 68" role="img" aria-label={`${done} of ${total} setup steps done`}>
        <circle cx="34" cy="34" r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
        <circle cx="34" cy="34" r={r} fill="none" stroke={next ? "var(--accent)" : "var(--green)"} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${(done / total) * C} ${C}`} transform="rotate(-90 34 34)" />
        <text x="34" y="39" textAnchor="middle" fontSize="15" fontWeight="700" style={{ fill: "var(--text)", fontFamily: "var(--mono)" }}>{done}/{total}</text>
      </svg>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div className="eyebrow">{next ? "Next step" : "All set"}</div>
        <h2 style={{ marginTop: 2 }}>{next ? next.label : "Everything is connected"}</h2>
        <p>{next ? next.detail : "Your sessions are reviewed, a maintainer is verified and payouts run through PayPal. Plan the next payout whenever you have funds available."}</p>
        {next?.command && <div style={{ marginTop: 12, maxWidth: 460 }}><CodeBlock>{next.command}</CodeBlock></div>}
      </div>
      {next?.cta && (next.cta.to
        ? <Link className="btn primary lg" to={next.cta.to}>{next.cta.label}<ArrowRight size={16} /></Link>
        : <a className="btn primary lg" href={next.cta.href} target="_blank" rel="noreferrer">{next.cta.label}<ArrowRight size={16} /></a>)}
      {!next && <span className="icon-tile green" style={{ width: 48, height: 48 }}><PartyPopper size={22} /></span>}
    </section>
  );
}

function Pipe({ n, to, label, value, foot }: { n: number; to: string; label: string; value: string; foot: string }) {
  return (
    <Link to={to} className="pipe-step">
      <span className="pipe-n"><span className="step-dot" style={{ width: 18, height: 18, fontSize: 10 }}>{n}</span>{label}</span>
      <span className="pipe-v">{value}</span>
      <span className="pipe-f">{foot}</span>
    </Link>
  );
}

/** A small Sankey-style picture of real ledger totals. */
export function FlowDiagram({ pool }: { pool: any }) {
  const cur = pool.currency;
  const gross = pool.fundingGross;
  const parts = [
    { label: "PayPal fees", v: -pool.fundingFees - pool.payoutFees, color: "var(--neutral-bar)" },
    { label: "Paid to maintainers", v: -pool.payoutsSent - pool.returned, color: "var(--teal)" },
    { label: "In flight", v: pool.inFlight, color: "var(--accent)" },
    { label: "Held for unclaimed", v: pool.reserved, color: "var(--amber)" },
    { label: "Available", v: pool.available, color: "var(--violet)" },
  ].filter((x) => x.v > 0);
  const W = 640, colW = 16, gap = 10, labelH = 34;
  // fees + paid + in flight + held + available always sums to the gross funded amount.
  const total = Math.max(gross, parts.reduce((a, x) => a + x.v, 0), 1);
  const scale = 220;
  // Each band keeps room for its two-line label, so small amounts (like fees) never overlap their neighbours.
  const bands = parts.map((x) => ({ ...x, h: Math.max((x.v / total) * scale, 4) }));
  const slots = bands.map((b) => Math.max(b.h, labelH));
  const H = slots.reduce((a, h) => a + h, 0) + gap * (bands.length - 1) + 30;
  let y = 20;
  const leftH = Math.max((gross / total) * scale, 8);
  const leftY = (H - leftH) / 2;
  let ly = leftY;
  return (
    <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Money flow: funded ${money(gross, cur)}, ${parts.map((x) => `${x.label} ${money(x.v, cur)}`).join(", ")}`}>
      <rect x={40} y={leftY} width={colW} height={leftH} rx={4} style={{ fill: "var(--accent)" }} />
      <text x={40} y={Math.max(leftY - 8, 12)} fontSize="12" className="t-strong" fontWeight={600}>Funded {money(gross, cur)}</text>
      {bands.map((part, i) => {
        const h = part.h;
        const sh = (part.v / total) * leftH;
        const sy = ly;
        ly += sh;
        const ty = y + (slots[i] - h) / 2;
        y += slots[i] + gap;
        const x1 = 40 + colW, x2 = 420;
        return (
          <g key={part.label}>
            <path
              d={`M${x1},${sy} C${(x1 + x2) / 2},${sy} ${(x1 + x2) / 2},${ty} ${x2},${ty} L${x2},${ty + h} C${(x1 + x2) / 2},${ty + h} ${(x1 + x2) / 2},${sy + sh} ${x1},${sy + sh} Z`}
              style={{ fill: part.color, opacity: 0.2 }}
            />
            <rect x={x2} y={ty} width={colW} height={h} rx={4} style={{ fill: part.color }} />
            <text x={x2 + colW + 10} y={ty + h / 2 - 3} fontSize="12.5" className="t-strong" fontWeight={560}>{part.label}</text>
            <text x={x2 + colW + 10} y={ty + h / 2 + 13} fontSize="12" className="t-muted" fontFamily="JetBrains Mono Variable, monospace">{money(part.v, cur)}</text>
          </g>
        );
      })}
    </svg>
  );
}
