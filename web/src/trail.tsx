import { Link } from "react-router-dom";
import { ExternalLink, Route as RouteIcon } from "lucide-react";
import { useApi } from "./api.ts";
import { dateTime, moneyStr, pct, plural } from "./format.ts";
import { BrandIcon, Drawer, EVIDENCE, EvidenceIcon, ErrorBox, Skeleton, Status } from "./ui.tsx";

/**
 * "Why did this repo get this amount?" Every allocation, the sessions it came from, the validated
 * weight and Muse Spark's rationale, and the evidence each weight cites. Nothing is recomputed here.
 */
export function TrailDrawer({ repo, onClose }: { repo: string; onClose: () => void }) {
  const { data, error } = useApi<any>(`/api/trail?repo=${encodeURIComponent(repo)}`, [repo]);
  const cur: string = data?.currency;
  const short = repo.replace("github.com/", "");
  return (
    <Drawer title={<span className="row" style={{ gap: 8 }}><RouteIcon size={17} color="var(--accent)" />Money trail</span>} sub={<span className="row" style={{ gap: 6 }}><BrandIcon name="github" size={13} />{short}</span>} onClose={onClose}>
      {error && <ErrorBox error={error} />}
      {!data ? (
        <div className="stack"><Skeleton h={60} /><Skeleton h={120} /><Skeleton h={120} /></div>
      ) : (
        <>
          {data.summary && (
            <div className="grid-3" style={{ gap: 10 }}>
              <Mini label="Held" value={moneyStr(data.summary.held, cur)} color="var(--amber)" />
              <Mini label="In flight" value={moneyStr(data.summary.in_flight, cur)} />
              <Mini label="Paid" value={moneyStr(data.summary.paid, cur)} color="var(--green)" />
            </div>
          )}
          <div className="row small muted" style={{ gap: 8 }}>
            Maintainer: <Status value={data.summary?.claim.status ?? "none"} label={data.summary?.claim.status === "verified" ? (data.summary.claim.github_login ? `@${data.summary.claim.github_login}` : "Verified") : data.summary?.claim.status === "pending" ? "Claim pending" : "Unclaimed"} />
            <div className="spacer" />
            <a href={`/r/${short}`} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>Public page <ExternalLink size={12} /></a>
          </div>

          <section className="stack" style={{ gap: 8 }}>
            <h3>Allocations</h3>
            {data.allocations.length === 0 ? <p className="muted small">No money has been allocated to this repo yet. It appears here once a payout run includes a session that relied on it.</p> : (
              <div className="summary">
                {data.allocations.map((a: any) => (
                  <div key={a.id} className="line-row" style={{ alignItems: "center" }}>
                    <span className="row" style={{ gap: 8 }}>
                      <Status value={a.status} />
                      <span className="small">{a.package.split(":")[1]} · {plural(a.session_ids.length, "session")}</span>
                      <Link className="small" to={`/settlements/${a.settlement_id}`} onClick={onClose}>{dateTime(a.created_at)}</Link>
                    </span>
                    <strong className="num">{moneyStr(a.amount, cur)}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="stack" style={{ gap: 8 }}>
            <h3>Why: the sessions and evidence behind it</h3>
            {data.sessions.length === 0 && <p className="muted small">No attributed session gives this repo's packages a share.</p>}
            {data.sessions.map((s: any) => (
              <div key={s.id} className="card flat" style={{ padding: 14 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Link to={`/sessions/${s.id}`} onClick={onClose}><strong>{s.project ?? "Session"}</strong></Link>
                  <span className="muted small">{dateTime(s.started_at)}</span>
                </div>
                {s.weights.length === 0 && <p className="muted small" style={{ marginTop: 6 }}>Its active attribution no longer gives this repo a share.</p>}
                {s.weights.map((w: any) => (
                  <div key={`${w.ecosystem}:${w.name}`} style={{ marginTop: 10 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{w.name}</span>
                      <Status value={w.classification} />
                      <span className="pill outline">{w.method === "llm" ? "Muse Spark" : "Baseline"}</span>
                      <div className="spacer" />
                      <span className="num" style={{ fontWeight: 650 }}>{pct(w.weight, 1)}</span>
                    </div>
                    <div className="bar" style={{ margin: "8px 0" }}><span style={{ width: `${Math.max(w.weight * 100, 2)}%` }} /></div>
                    {w.rationale && <p className="small" style={{ color: "var(--text-2)" }}>“{w.rationale}”</p>}
                    <div className="row" style={{ gap: 6, marginTop: 6 }}>
                      {w.evidence.slice(0, 10).map((e: any) => (
                        <span key={e.id} className="chip" title={`${e.id}${e.strength ? ` · ${e.strength}` : ""}`}>
                          <EvidenceIcon kind={e.kind ?? ""} size={13} />
                          {EVIDENCE[e.kind]?.label ?? e.id}
                        </span>
                      ))}
                      {w.evidence.length > 10 && <span className="muted small">+{w.evidence.length - 10} more</span>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>

          {data.payout_items.length > 0 && (
            <section className="stack" style={{ gap: 8 }}>
              <h3>PayPal payout items</h3>
              <div className="summary">
                {data.payout_items.map((i: any) => (
                  <div key={i.sender_item_id} className="line-row" style={{ alignItems: "center" }}>
                    <span className="row" style={{ gap: 8 }}><Status value={i.transaction_status ?? "PENDING"} /><code className="small">{i.sender_item_id}</code></span>
                    <span className="num">{moneyStr(i.amount, cur)}{i.fee != null && <span className="muted small"> · fee {moneyStr(i.fee, cur)}</span>}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </Drawer>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="card flat" style={{ padding: 12 }}>
      <div className="muted small">{label}</div>
      <div className="num" style={{ fontSize: 18, fontWeight: 650, color }}>{value}</div>
    </div>
  );
}
