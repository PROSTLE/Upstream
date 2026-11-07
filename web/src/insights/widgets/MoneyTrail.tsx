// "Money trail": for each maintainer repo, where its money is now. Held (no verified maintainer yet),
// sent (in a PayPal batch that hasn't settled) and paid, as one stacked bar, with PayPal's own status
// for the latest payout and how long any hold has left. Clicking a repo filters the board.
import type { AgWidgetParams } from "ag-studio";
import { AgIncompleteDataMappingOverlay } from "ag-studio-react";
import { use, type MouseEvent } from "react";
import type { InsightsContext, MoneyTrailDef } from "./types.ts";

const DAY = 86_400_000;
const CLAIM: Record<string, { label: string; tone: string }> = {
  verified: { label: "verified", tone: "green" },
  pending: { label: "claim pending", tone: "amber" },
  receiver_unclaimed: { label: "PayPal unclaimed", tone: "amber" },
  revoked: { label: "claim revoked", tone: "red" },
  unclaimed: { label: "unclaimed", tone: "amber" },
};
const PAYPAL_TONE: Record<string, string> = { SUCCESS: "green", PENDING: "blue", UNCLAIMED: "amber", ONHOLD: "amber", RETURNED: "red", REFUNDED: "red", REVERSED: "red", FAILED: "red", DENIED: "red", BLOCKED: "red" };

export default function MoneyTrail(params: AgWidgetParams<MoneyTrailDef>) {
  const { widgetApi, dataMapping, format } = params;
  const ctx = params.context as InsightsContext | undefined;
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: ctx?.currency ?? "USD" });
  const style = format?.style ?? {};
  const repo = dataMapping.repo?.at(0);
  const held = dataMapping.held?.at(0);
  const sent = dataMapping.sent?.at(0);
  const paid = dataMapping.paid?.at(0);
  const claim = dataMapping.claim?.at(0);
  const paypal = dataMapping.paypal?.at(0);
  const expires = dataMapping.expires?.at(0);
  if (!repo || !held || !sent || !paid) return <AgIncompleteDataMappingOverlay />;

  const fields = [repo, held, sent, paid, ...[claim, paypal, expires].filter((f) => f != null)];
  const res = use(widgetApi.getData({ fields }, { queryId: "trail" }));
  const rows = res.results.rows
    .map((r) => {
      const h = Number(r[held.key] ?? 0), s = Number(r[sent.key] ?? 0), p = Number(r[paid.key] ?? 0);
      const exp = expires ? r[expires.key] : null;
      return {
        repo: String(r[repo.key] ?? ""),
        held: h, sent: s, paid: p, total: h + s + p,
        claim: claim ? (r[claim.key] as string | null) : null,
        paypal: paypal ? (r[paypal.key] as string | null) : null,
        expiresAt: exp != null && exp !== "" ? new Date(exp as string | number) : null,
      };
    })
    .filter((r) => r.repo && r.total > 0)
    .sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo))
    .slice(0, Math.max(1, style.maxRows ?? 8));

  const heading = style.heading ?? "Money trail";
  if (!rows.length) {
    return (
      <div className="ins-widget">
        <div className="ins-head"><div className="ins-title">{heading}</div></div>
        <p className="ins-empty">No money has been earmarked for a maintainer yet: it appears after the first payout run.</p>
      </div>
    );
  }

  const max = Math.max(...rows.map((r) => r.total));
  const w = (v: number) => `${(v / max) * 100}%`;
  const highlight = res.crossFilter ? new Set(res.crossFilter.rows.map((r) => String(r[repo.key]))) : null;
  const selected = new Set((widgetApi.getCrossFilterSelections() ?? []).flatMap((s) => (s.type === "value" ? s.values.map(String) : [])));
  const toggle = (name: string, e: MouseEvent) => {
    e.stopPropagation();
    widgetApi.toggleCrossFilter({ type: "value", value: name, field: repo, group: 0, reset: !(e.metaKey || e.ctrlKey) });
  };
  const now = Date.now();

  return (
    <div className="ins-widget" onClick={() => widgetApi.resetCrossFilter()}>
      <div className="ins-head">
        <div className="ins-title">{heading}</div>
        <div className="ins-legend" aria-hidden>
          <span><i className="ins-sw held" />Held</span>
          <span><i className="ins-sw sent" />Sent</span>
          <span><i className="ins-sw paid" />Paid</span>
        </div>
      </div>
      <div className="ins-rows" role="list" aria-label={heading}>
        {rows.map((r) => {
          const c = r.claim ? CLAIM[r.claim] ?? { label: r.claim, tone: "neutral" } : null;
          const days = r.held > 0 && r.expiresAt ? Math.ceil((r.expiresAt.getTime() - now) / DAY) : null;
          const dim = highlight && !highlight.has(r.repo);
          const parts = [r.held > 0 && `${money.format(r.held)} held`, r.sent > 0 && `${money.format(r.sent)} sent`, r.paid > 0 && `${money.format(r.paid)} paid`].filter(Boolean).join(", ");
          return (
            <button
              key={r.repo}
              type="button"
              role="listitem"
              className={`ins-trail${selected.has(r.repo) ? " selected" : ""}${dim ? " dim" : ""}`}
              onClick={(e) => toggle(r.repo, e)}
              aria-pressed={selected.has(r.repo)}
              aria-label={`${r.repo}: ${parts}${c ? `, ${c.label}` : ""}${r.paypal ? `, PayPal ${r.paypal}` : ""}. Click to filter the board.`}
            >
              <span className="ins-trail-top">
                <span className="ins-name">{r.repo}</span>
                {c && <span className={`ins-tag ${c.tone}`}>{c.label}</span>}
                {r.paypal && <span className={`ins-tag ${PAYPAL_TONE[r.paypal] ?? "neutral"}`} title="PayPal's own transaction status">PayPal {r.paypal}</span>}
                <span className="ins-amount">{money.format(r.total)}</span>
              </span>
              <span className="ins-stack" aria-hidden>
                {r.held > 0 && <span className="held" style={{ width: w(r.held) }} />}
                {r.sent > 0 && <span className="sent" style={{ width: w(r.sent) }} />}
                {r.paid > 0 && <span className="paid" style={{ width: w(r.paid) }} />}
              </span>
              <span className="ins-trail-foot">
                {parts}
                {days != null && <> · {days > 0 ? `hold expires in ${days} day${days === 1 ? "" : "s"}` : "hold has expired"}</>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
