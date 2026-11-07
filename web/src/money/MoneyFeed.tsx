// The written record beside the diagram: every money event as a sentence, with what confirmed it and PayPal's id.
import { Link } from "react-router-dom";
import { CheckCircle2, CircleDollarSign, Copy, Hourglass, Percent, Send, Undo2, XCircle } from "lucide-react";
import { ago, shortId } from "../format.ts";
import { useCopy } from "../ui.tsx";
import type { MoneyEvent } from "./stream.tsx";

function eventIcon(e: MoneyEvent) {
  if (e.type === "batch") return <Send size={15} color="var(--accent)" aria-hidden />;
  if (e.type === "earmark") return <Hourglass size={15} color="var(--amber)" aria-hidden />;
  if (e.kind === "FUNDING_FEE" || e.kind === "PAYOUT_FEE") return <Percent size={15} color="var(--muted)" aria-hidden />;
  if (e.type === "ledger") return <CircleDollarSign size={15} color="var(--accent)" aria-hidden />;
  if (e.status_to === "SUCCESS") return <CheckCircle2 size={15} color="var(--green)" aria-hidden />;
  if (e.status_to === "FAILED" || e.status_to === "BLOCKED") return <XCircle size={15} color="var(--red)" aria-hidden />;
  if (e.status_to === "RETURNED" || e.status_to === "REFUNDED" || e.status_to === "REVERSED") return <Undo2 size={15} color="var(--violet)" aria-hidden />;
  return <Hourglass size={15} color="var(--amber)" aria-hidden />;
}

function TriggerBadge({ e }: { e: MoneyEvent }) {
  if (e.trigger.via === "webhook") return <span className="pill green" title={`PayPal event ${e.trigger.event_id}`}>Webhook · verified</span>;
  if (e.trigger.via === "none") return <span className="pill amber">No PayPal call</span>;
  return <span className="pill">Read from PayPal API</span>;
}

const ID_LABELS: [string, string][] = [
  ["payout_item_id", "item"],
  ["capture_id", "capture"],
  ["payout_batch_id", "batch"],
  ["transaction_id", "transaction"],
];

export function MoneyFeed({ events, maxHeight, onTrail }: { events: MoneyEvent[]; maxHeight?: number; onTrail?: (repo: string) => void }) {
  const copy = useCopy();
  if (!events.length) return <p className="muted small mf-feed-empty">Money events appear here as PayPal confirms them.</p>;
  return (
    <ol className="mf-feed" role="log" aria-label="Money events" aria-live="polite" style={{ maxHeight }}>
      {events.map((e) => {
        const id = ID_LABELS.find(([k]) => e.paypal_ids[k]);
        return (
          <li key={e.id} className="mf-item">
            <span className="mf-item-icon">{eventIcon(e)}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mf-item-head">
                <span>{e.label}</span>
                <time className="muted small" dateTime={e.at} title={new Date(e.at).toLocaleString()}>{ago(e.at)}</time>
              </div>
              <div className="mf-item-meta small muted">
                <TriggerBadge e={e} />
                {e.backfilled && <span className="pill outline">From history</span>}
                {e.trigger.via === "webhook" && <span>{e.trigger.event_type} · signature verified</span>}
                {id && (
                  <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                    {id[1]} <code title={e.paypal_ids[id[0]]}>{shortId(e.paypal_ids[id[0]], 8)}</code>
                    <button type="button" className="btn ghost sm icon mf-copy" aria-label={`Copy PayPal ${id[1]} id`} onClick={() => void copy(e.paypal_ids[id[0]], "PayPal id copied")}><Copy size={11} /></button>
                  </span>
                )}
                {e.repo && onTrail && <button type="button" className="mf-link-btn" onClick={() => onTrail(e.repo!)}>Money trail ›</button>}
                {e.settlement_id && <Link to={`/settlements/${e.settlement_id}`}>Payout ›</Link>}
                {e.ref_type === "topup" && <Link to="/funding">Funding ›</Link>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
