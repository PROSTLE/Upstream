import { useSearchParams } from "react-router-dom";
import { CalendarClock, CheckCircle2, RefreshCw, Repeat, ShieldCheck, Wallet, XCircle } from "lucide-react";
import { api, useApi } from "../api.ts";
import { dateTime, money, moneyStr } from "../format.ts";
import { ActionButton, BrandIcon, Card, CheckRow, ErrorBox, Loading, PageHead, Status, useToast } from "../ui.tsx";

export function Funding() {
  const { data, error, loading, reload } = useApi<any>("/api/funding");
  const [params] = useSearchParams();
  const toast = useToast();
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorBox error={error ?? "Could not load funding"} /></div>;
  const sub = data.subscription;
  const p = data.pool;
  const cur = p.currency;

  return (
    <div className="page">
      <PageHead
        title="Funding"
        subtitle={`A fixed "agent tithe" you approve once with PayPal. Upstream never charges more than the plan and only distributes money PayPal has confirmed.`}
      />
      {params.get("subscribed") && (
        <div className="callout green"><CheckCircle2 size={18} color="var(--green)" /><div>PayPal returned subscription <code>{params.get("subscribed")}</code> with status <strong>{params.get("status")}</strong>. Payments appear in the pool once PayPal reports them.</div></div>
      )}
      {params.get("cancelled") && <div className="callout amber"><XCircle size={18} color="var(--amber)" /><div>You left PayPal without approving. Nothing was charged.</div></div>}
      {params.get("error") && <ErrorBox error={params.get("error")!} />}

      <div className="split">
        <Card title="Agent tithe" sub="PayPal Subscriptions API" icon={<Repeat size={17} />}>
          <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
            <span className="stat-value">{moneyStr(data.tithe.amount, cur)}</span>
            <span className="muted">{cur} / {data.tithe.interval.toLowerCase()}</span>
          </div>
          <div className="divider" style={{ margin: "16px 0" }} />
          <dl className="kv">
            <dt>Subscription</dt>
            <dd>{sub ? <span className="row" style={{ gap: 8 }}><code>{sub.id}</code><Status value={sub.status} /></span> : <span className="muted">Not started</span>}</dd>
            <dt>Subscriber</dt>
            <dd>{sub?.subscriber_email ?? "—"}</dd>
            <dt>Plan</dt>
            <dd>{data.plan_id ? <code>{data.plan_id}</code> : <span className="muted">Run <code>npm run setup:paypal</code></span>}</dd>
            <dt>Product</dt>
            <dd>{data.product_id ? <code>{data.product_id}</code> : "—"}</dd>
            <dt>Last update</dt>
            <dd>{dateTime(sub?.updated_at)}</dd>
          </dl>
          <div className="row" style={{ marginTop: 18 }}>
            <ActionButton
              className="btn primary"
              disabled={!data.plan_id || sub?.status === "ACTIVE"}
              onRun={async () => {
                const r = await api<{ approveUrl: string }>("/api/funding/subscribe", { body: {}, admin: true });
                window.location.href = r.approveUrl;
              }}
            >
              <BrandIcon name="paypal" size={15} mono />
              {sub?.status === "ACTIVE" ? "Subscription active" : "Approve with PayPal"}
            </ActionButton>
            <ActionButton
              disabled={!sub}
              onRun={async () => {
                const r = await api<{ status: string; booked: number }>("/api/funding/sync", { body: {}, admin: true });
                toast(`PayPal says ${r.status}; ${r.booked} new payment(s) booked.`);
                await reload();
              }}
            >
              <RefreshCw size={15} />
              Sync from PayPal
            </ActionButton>
          </div>
        </Card>

        <Card title="How funds are handled" icon={<ShieldCheck size={17} />} tone="teal">
          <CheckRow ok label="Money in is read from PayPal, not assumed" detail="Subscription transactions (gross, fee) are pulled from /v1/billing/subscriptions/{id}/transactions; webhooks only trigger that sync, so nothing is booked twice." />
          <CheckRow ok label="PayPal's fees are shown, not hidden" detail="Funding fees and per-item payout fees are booked from the amounts PayPal reports." />
          <CheckRow ok label="Unclaimed money doesn't leak" detail="Allocations for repos without a verified maintainer are held, then released back to the pool." />
          <CheckRow ok label="Cancel any time in PayPal" detail="The subscription is yours; cancelling it in PayPal stops new funding immediately." />
        </Card>
      </div>

      <Card title="Pool reconciliation" sub="Funded + fees + payouts + returns = balance; balance − held − in flight = available" icon={<Wallet size={17} />} tone="violet">
        <div className="grid-4" style={{ gap: 12 }}>
          {[
            ["Funded (gross)", p.fundingGross],
            ["PayPal funding fees", p.fundingFees],
            ["Payouts sent", p.payoutsSent],
            ["Payout fees", p.payoutFees],
            ["Returned / cancelled", p.returned],
            ["Balance", p.balance],
            ["Held for unclaimed", -p.reserved],
            ["In flight", -p.inFlight],
          ].map(([label, v]) => (
            <div key={label as string} className="card" style={{ padding: 14, boxShadow: "none", background: "var(--surface-2)" }}>
              <div className="muted small">{label}</div>
              <div className="num" style={{ fontSize: 18, fontWeight: 620, color: (v as number) < 0 ? "var(--red)" : "var(--text)" }}>{money(v as number, cur)}</div>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <CalendarClock size={16} color="var(--muted)" />
          <span className="muted">Available to allocate now:</span>
          <strong className="num">{money(p.available, cur)}</strong>
        </div>
      </Card>
    </div>
  );
}
