import { Bot, Clock, Gavel, Hourglass, Percent, Scale, ShieldCheck, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { moneyStr, pct } from "../format.ts";
import { useOverview } from "../overview.tsx";
import { Card, ErrorBox, Loading, PageHead } from "../ui.tsx";

/** The rules money follows, read from the server's live config. Nothing here is a default made up by the UI. */
export function Policy() {
  const { data, error } = useOverview();
  if (error && !data) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <div className="page"><Loading rows={2} /></div>;
  const p = data.policy;
  const cur = data.pool.currency;
  const rules: { icon: ReactNode; title: string; value: string; env: string; what: string }[] = [
    { icon: <Percent size={16} />, title: "Most one package can get from a session", value: pct(p.max_package_share), env: "POLICY_MAX_PACKAGE_SHARE", what: "Even when one package did everything, it gets at most this share of the session's slice. The rest stays in the pool." },
    { icon: <Wallet size={16} />, title: "Smallest payout sent", value: moneyStr(p.min_payout, cur), env: "POLICY_MIN_PAYOUT", what: "Smaller amounts carry over for that maintainer instead of costing a PayPal fee each." },
    { icon: <Wallet size={16} />, title: "Largest single payout item", value: moneyStr(p.max_payout, cur), env: "POLICY_MAX_PAYOUT", what: "One item never goes above this. Older held money for the repo goes in first; anything over the cap stays in the shared pool." },
    { icon: <Scale size={16} />, title: "Fee reserve while a batch is open", value: pct(p.fee_reserve, 1), env: "POLICY_PAYOUT_FEE_RESERVE", what: "Kept back from the pool until PayPal reports each item's real fee, then released." },
    { icon: <Hourglass size={16} />, title: "How long money waits for an unclaimed repo", value: `${p.reserve_days} days`, env: "POLICY_RESERVE_DAYS", what: "After this, an unclaimed repo's share goes back to the pool for other maintainers." },
    { icon: <Clock size={16} />, title: "When an unclaimed PayPal payout is cancelled", value: `${p.cancel_unclaimed_after_days} days`, env: "POLICY_CANCEL_UNCLAIMED_AFTER_DAYS", what: `PayPal returns unclaimed payouts after 30 days anyway; ${data.brand} cancels sooner, re-holds the money and asks the maintainer to fix their email.` },
    { icon: <Wallet size={16} />, title: "Largest one-time top-up", value: p.max_topup ? moneyStr(p.max_topup, cur) : `No ${data.brand} cap`, env: "POLICY_MAX_TOPUP", what: p.max_topup ? "Dashboard top-ups above this are refused." : "Only PayPal's own limits apply to top-ups from the dashboard." },
    { icon: <Bot size={16} />, title: "What your agent may request per 24 hours", value: p.max_agent_topup ? moneyStr(p.max_agent_topup, cur) : "Off", env: "POLICY_MAX_AGENT_TOPUP", what: p.max_agent_topup ? "Every request counts toward it, approved or not. The agent only ever gets a PayPal link you approve." : "Agents can't request top-ups at all." },
  ];
  return (
    <div className="page">
      <PageHead
        eyebrow="More"
        title="Payout rules"
        subtitle="These rules are enforced in code before PayPal is called. The AI can't change them."
      />
      <div className="grid-2">
        {rules.map((r) => (
          <div key={r.env} className="card card-pad stack" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
              <div className="icon-tile" style={{ width: 30, height: 30 }}>{r.icon}</div>
              <h3 style={{ flex: 1 }}>{r.title}</h3>
              <span className="num" style={{ fontWeight: 650, fontSize: 16 }}>{r.value}</span>
            </div>
            <p className="small" style={{ color: "var(--text-2)" }}>{r.what}</p>
            <code className="small faint">{r.env}</code>
          </div>
        ))}
      </div>
      <Card title="How code checks the AI's proposal" sub="Runs after every AI review" icon={<Gavel size={17} />} tone="violet">
        <ul className="stack" style={{ margin: 0, paddingLeft: 18, gap: 8 }}>
          <li>Drops any package that isn't a candidate in the session (no hallucinated packages).</li>
          <li>Drops evidence ids that don't exist, and zeroes any weight not backed by evidence linked to that package.</li>
          <li>Never pays a package that is merely present in the manifest.</li>
          <li>Normalises the weights and applies the per-package cap above.</li>
          <li>Flags weak evidence with a high weight, strong evidence left unpaid, and large disagreement with the import-count baseline.</li>
        </ul>
      </Card>
      <Card title="Who can receive money" icon={<ShieldCheck size={17} />} tone="green">
        <p className="small" style={{ color: "var(--text-2)" }}>
          Only a maintainer who proved control of the repository: GitHub <strong>admin or maintain</strong> permission, or a token committed to the repo's FUNDING.yml. Package-to-repo links alone never release money. When Log in with PayPal is on, the payout email is the one PayPal has verified.
        </p>
      </Card>
    </div>
  );
}
