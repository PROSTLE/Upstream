import { Activity, AlertTriangle, Bot, CheckCircle2, CircleDashed, RefreshCw, Send, ShieldCheck, Webhook } from "lucide-react";
import { useApi } from "../api.ts";
import { ago, dateTime, plural } from "../format.ts";
import { BrandIcon, Card, ErrorBox, Loading, PageHead, Stat } from "../ui.tsx";

const STATE = {
  pass: { icon: <CheckCircle2 size={18} color="var(--green)" aria-label="Passes" />, pill: "green", label: "Passes" },
  fail: { icon: <AlertTriangle size={18} color="var(--red)" aria-label="Fails" />, pill: "red", label: "Fails" },
  empty: { icon: <CircleDashed size={18} color="var(--faint)" aria-label="Nothing to check yet" />, pill: "", label: "Nothing to check yet" },
} as const;

/**
 * The server re-checks its own records on every load (server/src/audit.ts). Nothing on this page is
 * asserted by the UI: a rule with no records to examine says so instead of showing a green tick.
 */
export function Audit() {
  const { data, error, loading, reload, updatedAt } = useApi<any>("/api/audit");
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorBox error={error ?? "Could not run the audit"} /></div>;
  const { summary: s, activity: a } = data;
  const nothingLive = a.paypal_calls.total === 0 && a.llm_runs === 0;

  return (
    <div className="page">
      <PageHead
        eyebrow="More"
        title="Safety checks"
        subtitle="The app re-checks its own records every time this page loads. If there's nothing to check yet, it says so instead of showing a green tick."
        actions={<button className="btn" onClick={() => void reload()}><RefreshCw size={15} />Run again</button>}
      />

      <section className="hero" aria-label="Audit summary">
        <span className={`icon-tile ${s.fail ? "red" : s.pass ? "green" : ""}`} style={{ width: 48, height: 48 }}>{s.fail ? <AlertTriangle size={22} /> : <ShieldCheck size={22} />}</span>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="eyebrow">Ran {updatedAt ? ago(new Date(updatedAt).toISOString()) : "just now"} · {dateTime(data.generated_at)}</div>
          <h2 style={{ marginTop: 2 }}>
            {s.fail ? `${plural(s.fail, "check")} failing` : s.pass ? `All ${plural(s.pass, "check")} with records pass` : "Nothing to check yet: no records exist"}
            {(s.fail || s.pass) && s.empty ? ` · ${s.empty} with no records yet` : ""}
          </h2>
          <p>
            {s.fail
              ? "Each failure lists the records involved. Nothing here is fixed automatically: investigate before planning another payout."
              : "Checks run on real records only, so this list grows as money moves."}
          </p>
        </div>
      </section>

      {nothingLive && (
        <div className="callout amber">
          <AlertTriangle size={18} color="var(--amber)" />
          <div>Nothing has gone through PayPal or Muse Spark in your account yet, so there are few real records to check. A pass means the rules hold for what exists, not that a full run has happened.</div>
        </div>
      )}

      <div className="grid-4">
        <Stat label="PayPal API calls" value={a.paypal_calls.total} icon={<BrandIcon name="paypal" size={15} />} foot={a.paypal_calls.total ? `${a.paypal_calls.succeeded} succeeded · last ${ago(a.paypal_calls.last_at)}` : "None yet"} />
        <Stat label="Webhooks verified by PayPal" value={a.webhooks.verified ?? 0} icon={<Webhook size={15} />} tone="teal" foot={`${plural(a.webhooks.received, "event")} received`} />
        <Stat label="Muse Spark attributions" value={a.llm_runs} icon={<Bot size={15} />} tone="violet" foot={a.models.length ? a.models.join(", ") : "None yet"} />
        <Stat label="Payout items PayPal reported on" value={a.payout_items_confirmed} icon={<Send size={15} />} tone="green" foot={`${plural(a.ledger_entries, "ledger entry", "ledger entries")} · ${plural(a.hook_events, "hook event")}`} />
      </div>

      <Card title="Checks" icon={<ShieldCheck size={17} />} tone="green">
        {data.checks.map((c: any) => {
          const st = STATE[c.status as keyof typeof STATE];
          return (
            <div key={c.id} className="check">
              {st.icon}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{c.label}</span>
                  <span className={`pill ${st.pill}`}><span className="dot" />{st.label}</span>
                </div>
                <div className="small" style={{ color: "var(--text-2)", marginTop: 2 }}>{c.why}</div>
                <div className="muted small" style={{ marginTop: 2 }}>{c.detail}</div>
                {c.failures.length > 0 && (
                  <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--red)" }}>
                    {c.failures.map((f: string) => <li key={f} style={{ overflowWrap: "anywhere" }}>{f}</li>)}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </Card>

      <Card title="What the validator caught" sub="Counted from the flags stored with every Muse Spark attribution" icon={<Activity size={17} />} tone="violet">
        {a.llm_runs === 0 ? (
          <p className="muted small">No Muse Spark attribution has run on this server yet.</p>
        ) : (
          <div className="summary">
            <div className="line-row"><span>Packages Muse Spark named that weren't in the session (dropped)</span><strong className="num">{a.validator.hallucinated_packages}</strong></div>
            <div className="line-row"><span>Evidence ids cited that don't exist (flagged)</span><strong className="num">{a.validator.unknown_evidence}</strong></div>
            <div className="line-row"><span>Weights without linked evidence (set to 0)</span><strong className="num">{a.validator.uncorroborated}</strong></div>
          </div>
        )}
      </Card>
    </div>
  );
}
