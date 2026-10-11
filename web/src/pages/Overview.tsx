import { Link } from "react-router-dom";
import {
  Activity, ArrowRight, BadgeCheck, CircleDollarSign, HandCoins, Hourglass, Landmark, PiggyBank, PlugZap, TerminalSquare, Webhook,
} from "lucide-react";
import { useApi } from "../api.ts";
import { ago, money } from "../format.ts";
import { Card, CheckRow, Empty, ErrorBox, Loading, PackageChip, PageHead, Stat, Status } from "../ui.tsx";

export function Overview() {
  const { data, error, loading } = useApi<any>("/api/overview");
  const sessions = useApi<any[]>("/api/sessions");
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorBox error={error ?? "Could not load overview"} /></div>;
  const p = data.pool;
  const cur = p.currency;
  const f = data.features;

  const steps = [
    { ok: f.paypal, label: "PayPal sandbox credentials", detail: "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env" },
    { ok: Boolean(data.plan_id), label: "Funding plan created in PayPal", detail: data.plan_id ? `Plan ${data.plan_id}` : "Run npm run setup:paypal" },
    { ok: data.subscription?.status === "ACTIVE", label: "Agent tithe subscription active", detail: data.subscription ? `Subscription ${data.subscription.id} is ${data.subscription.status}` : `Approve ${data.tithe.amount} ${cur} / ${data.tithe.interval.toLowerCase()} on the Funding page` },
    { ok: data.counts.sessions > 0, label: "Coding agent connected", detail: data.counts.sessions ? `${data.counts.sessions} session(s), ${data.counts.evidence} evidence records` : "Install the Claude Code hook from Connect your agent" },
    { ok: f.llm, label: "Claude attribution enabled", detail: f.llm ? `Model ${data.model}` : "Set ANTHROPIC_API_KEY" },
    { ok: data.counts.verified_claims > 0, label: "At least one verified maintainer", detail: "Maintainers prove repo ownership on the claim page" },
  ];
  const done = steps.filter((s) => s.ok).length;

  return (
    <div className="page">
      <PageHead
        title="Your agent's open-source footprint"
        subtitle="Upstream watches what your AI coding agent actually relies on, lets Claude weigh it under hard rules, and pays verified maintainers through PayPal Payouts."
        actions={
          <>
            <Link className="btn" to="/sessions"><TerminalSquare size={16} />Sessions</Link>
            <Link className="btn primary" to="/settlements"><HandCoins size={16} />Plan payout</Link>
          </>
        }
      />

      <div className="grid-4">
        <Stat label="Available to allocate" value={money(p.available, cur).replace(/[^\d.,-]/g, "")} currency={cur} icon={<PiggyBank size={15} />} foot="Confirmed by PayPal, minus earmarks" />
        <Stat label="Funded" value={money(p.fundingGross, cur).replace(/[^\d.,-]/g, "")} currency={cur} tone="teal" icon={<Landmark size={15} />} foot={`PayPal fees ${money(-p.fundingFees, cur)}`} />
        <Stat label="Paid to maintainers" value={money(-p.payoutsSent - p.returned, cur).replace(/[^\d.,-]/g, "")} currency={cur} tone="green" icon={<BadgeCheck size={15} />} foot={`Payout fees ${money(-p.payoutFees, cur)}`} />
        <Stat label="Held for unclaimed repos" value={money(p.reserved, cur).replace(/[^\d.,-]/g, "")} currency={cur} tone="amber" icon={<Hourglass size={15} />} foot={`Released after ${data.policy.reserve_days} days if nobody claims`} />
      </div>

      <div className="split">
        <Card title="Where the money goes" sub="Every number below comes from PayPal-confirmed ledger entries" icon={<CircleDollarSign size={17} />}>
          {p.fundingGross === 0 ? (
            <Empty icon={<CircleDollarSign size={22} />} title="No funds yet">
              Approve the agent tithe on the <Link to="/funding">Funding</Link> page. The first subscription payment lands here once PayPal confirms it.
            </Empty>
          ) : (
            <FlowDiagram pool={p} />
          )}
        </Card>
        <Card title="Getting started" sub={`${done} of ${steps.length} done`} icon={<PlugZap size={17} />} tone="violet">
          {steps.map((s) => <CheckRow key={s.label} ok={s.ok} label={s.label} detail={s.detail} />)}
        </Card>
      </div>

      <div className="split">
        <Card title="Recent agent sessions" icon={<TerminalSquare size={17} />} actions={<Link className="btn ghost sm" to="/sessions">All <ArrowRight size={14} /></Link>}>
          {!sessions.data?.length ? (
            <Empty icon={<TerminalSquare size={22} />} title="No sessions recorded">
              <Link to="/connect">Connect Claude Code</Link> and start coding. Every tool call becomes evidence.
            </Empty>
          ) : (
            <div className="list" style={{ margin: "-16px -20px -20px" }}>
              {sessions.data.slice(0, 6).map((s) => (
                <Link key={s.id} to={`/sessions/${s.id}`} className="list-item" style={{ color: "inherit" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{s.project ?? "unknown project"}</strong>
                      <Status value={s.status} />
                    </div>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      {s.top.length ? s.top.map((t: any) => <PackageChip key={t.name} ecosystem={t.ecosystem} name={t.name} weight={t.weight} />) : <span className="muted small">{s.evidence_count} evidence records, not attributed yet</span>}
                    </div>
                  </div>
                  <span className="muted small">{ago(s.last_event_at)}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card title="PayPal activity" sub="API calls and verified webhooks" icon={<Activity size={17} />} tone="teal">
          {!data.recent_paypal_calls.length && !data.recent_webhooks.length ? (
            <Empty icon={<Webhook size={22} />} title="No PayPal traffic yet" />
          ) : (
            <div className="timeline">
              {[
                ...data.recent_webhooks.map((w: any) => ({ at: w.received_at, kind: "webhook", w })),
                ...data.recent_paypal_calls.map((c: any) => ({ at: c.at, kind: "call", c })),
              ]
                .sort((a, b) => b.at.localeCompare(a.at))
                .slice(0, 8)
                .map((x: any, i: number) => (
                  <div key={i} className="tl-item">
                    <div className="tl-icon">{x.kind === "webhook" ? <Webhook size={14} color="var(--teal)" /> : <ArrowRight size={14} color="var(--accent)" />}</div>
                    <div style={{ minWidth: 0 }}>
                      {x.kind === "webhook" ? (
                        <>
                          <div className="row" style={{ gap: 8 }}><code>{x.w.event_type}</code><Status value={x.w.verification_status === "SUCCESS" ? "verified" : "FAILED"} label={x.w.verification_status === "SUCCESS" ? "Signature verified" : x.w.verification_status} /></div>
                          <div className="muted small">{ago(x.at)}</div>
                        </>
                      ) : (
                        <>
                          <div className="row" style={{ gap: 8 }}><code>{x.c.method} {x.c.path}</code><span className={`pill ${x.c.status && x.c.status < 300 ? "green" : "red"}`}>{x.c.status ?? "network"}</span></div>
                          <div className="muted small">{ago(x.at)} · {x.c.duration_ms} ms{x.c.debug_id ? ` · debug ${x.c.debug_id}` : ""}</div>
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/** A small Sankey-style picture of real ledger totals. */
export function FlowDiagram({ pool }: { pool: any }) {
  const cur = pool.currency;
  const gross = pool.fundingGross;
  const parts = [
    { label: "PayPal fees", v: -pool.fundingFees - pool.payoutFees, color: "#b9bbc4" },
    { label: "Paid to maintainers", v: -pool.payoutsSent - pool.returned, color: "#0f9d94" },
    { label: "In flight", v: pool.inFlight, color: "#2f5bea" },
    { label: "Held for unclaimed", v: pool.reserved, color: "#c27803" },
    { label: "Available", v: pool.available, color: "#6d4ae0" },
  ].filter((x) => x.v > 0);
  const W = 640, H = 260, colW = 16, gap = 10;
  // fees + paid + in flight + held + available always sums to the gross funded amount.
  const total = Math.max(gross, parts.reduce((a, x) => a + x.v, 0), 1);
  const usable = H - gap * (parts.length - 1) - 20;
  let y = 10;
  const leftH = Math.max((gross / total) * usable, 8);
  const leftY = (H - leftH) / 2;
  let ly = leftY;
  return (
    <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Money flow from funding to maintainers">
      <rect x={40} y={leftY} width={colW} height={leftH} rx={4} fill="#2f5bea" />
      <text x={40} y={leftY - 8} fontSize="12" fill="#3d3f47" fontWeight={600}>Funded {money(gross, cur)}</text>
      {parts.map((part) => {
        const h = Math.max((part.v / total) * usable, 4);
        const sh = (part.v / total) * leftH;
        const sy = ly;
        ly += sh;
        const ty = y;
        y += h + gap;
        const x1 = 40 + colW, x2 = 420;
        return (
          <g key={part.label}>
            <path
              d={`M${x1},${sy} C${(x1 + x2) / 2},${sy} ${(x1 + x2) / 2},${ty} ${x2},${ty} L${x2},${ty + h} C${(x1 + x2) / 2},${ty + h} ${(x1 + x2) / 2},${sy + sh} ${x1},${sy + sh} Z`}
              fill={part.color}
              opacity={0.18}
            />
            <rect x={x2} y={ty} width={colW} height={h} rx={4} fill={part.color} />
            <text x={x2 + colW + 10} y={ty + Math.min(h / 2, 14) + 4} fontSize="12.5" fill="#15161a" fontWeight={560}>{part.label}</text>
            <text x={x2 + colW + 10} y={ty + Math.min(h / 2, 14) + 20} fontSize="12" fill="#6c6e78" fontFamily="JetBrains Mono Variable, monospace">{money(part.v, cur)}</text>
          </g>
        );
      })}
    </svg>
  );
}
