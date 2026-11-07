import { Link } from "react-router-dom";
import {
  ArrowRight, CircleDollarSign, ListChecks, PartyPopper, Percent, PlugZap, TerminalSquare,
} from "lucide-react";
import { useApi } from "../api.ts";
import { ago, money, moneyStr, pct } from "../format.ts";
import { MoneyFlow, NoMoneyYet } from "../money/MoneyFlow.tsx";
import { useMoneyRefresh } from "../money/stream.tsx";
import { setupSteps, useOverview } from "../overview.tsx";
import { CheckRow, CodeBlock, Card, Empty, ErrorBox, Loading, PackageChip, PageHead, Stat, Status } from "../ui.tsx";

export function Overview() {
  const { data, error, reload } = useOverview();
  const sessions = useApi<any[]>("/api/sessions", [], { poll: 10000 });
  useMoneyRefresh((e) => e.type === "ledger" || e.type === "earmark" || e.type === "batch", reload);
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
          {p.fundingGross === 0 ? <NoMoneyYet /> : <MoneyFlow variant="compact" />}
        </Card>
        <div className="stack" style={{ gap: 16 }}>
          <Stat
            label={`PayPal fees ≤ ${pct(data.policy.max_fee_share)} of every payout`}
            value={moneyStr(data.policy.payout_threshold, cur)}
            icon={<Percent size={15} />}
            tone="teal"
            foot={
              <>
                Payouts wait until they reach this, so PayPal's {moneyStr(data.policy.fee_estimate, cur)} fee stays within the limit.
                {data.policy.highest_fee_share > data.policy.max_fee_share && <> One payout before this rule lost {pct(data.policy.highest_fee_share, 1)}.</>}
              </>
            }
          />
          <Card title="Setup checklist" sub={`${done} of ${steps.length} done`} icon={<ListChecks size={17} />} tone="violet">
            {steps.map((s) => <CheckRow key={s.id} ok={s.ok} label={s.label} detail={s.ok ? s.detail : undefined} />)}
          </Card>
        </div>
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
