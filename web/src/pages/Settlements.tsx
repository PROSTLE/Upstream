import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Ban, Braces, CheckCheck, FileJson, HandCoins, Hourglass, ListChecks, RefreshCw, Repeat2, Route, Send, ShieldCheck, TerminalSquare, X,
} from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { api, useApi } from "../api.ts";
import { dateTime, money, moneyStr, pct, shortId, plural } from "../format.ts";
import { ActionButton, BrandIcon, Card, CheckRow, Empty, ErrorBox, Loading, Modal, PageHead, Status, Stepper, useToast } from "../ui.tsx";
import { Grid } from "../data.tsx";
import { BatchFlow } from "../money/MoneyFlow.tsx";
import { useMoneyRefresh } from "../money/stream.tsx";
import { TrailDrawer } from "../trail.tsx";
import { useBrand } from "../brand.tsx";

export function Settlements() {
  const brand = useBrand();
  const { data, error, loading } = useApi<any[]>("/api/settlements");
  const nav = useNavigate();
  const toast = useToast();
  return (
    <div className="page">
      <PageHead
        eyebrow="Step 4"
        title="Pay maintainers"
        subtitle={`${brand} works out who gets what and checks it against your budget and rules. You approve, then PayPal sends the money.`}
        actions={
          <ActionButton
            className="btn primary"
            onRun={async () => {
              const s = await api<any>("/api/settlements/plan", { body: {}, admin: true });
              if (s.status === "empty") toast("Nothing to settle: no attributed sessions or claimable reservations.", "error");
              else nav(`/settlements/${s.id}`);
            }}
          >
            <HandCoins size={16} />
            Plan payout
          </ActionButton>
        }
      />
      {error && <ErrorBox error={error} />}
      {loading && !data ? <Loading /> : !data?.length ? (
        <Card>
          <Empty icon={<Send size={22} />} title="No payouts yet" action={<Link className="btn" to="/sessions"><TerminalSquare size={15} />Review a session</Link>}>
            Plan a payout once a session is attributed. Shares for repos whose maintainer hasn't verified yet are held, never paid to an unverified address.
          </Empty>
        </Card>
      ) : (
        <div className="grid-3">
          {data.map((s) => (
            <Link key={s.id} to={`/settlements/${s.id}`} className="card card-pad" style={{ color: "inherit", display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="row">
                <div className="icon-tile teal"><Send size={16} /></div>
                <div>
                  <div style={{ fontWeight: 600 }}>{dateTime(s.created_at)}</div>
                  <div className="muted small mono">{s.id}</div>
                </div>
                <div className="spacer" />
                <Status value={s.status} />
              </div>
              <div className="row" style={{ gap: 18 }}>
                <div><div className="muted small">To maintainers</div><div className="num" style={{ fontSize: 20, fontWeight: 650 }}>{money(s.planned_minor, s.currency)}</div></div>
                <div><div className="muted small">Held</div><div className="num" style={{ fontSize: 20, fontWeight: 650, color: "var(--amber)" }}>{money(s.reserved_minor, s.currency)}</div></div>
              </div>
              <div className="row small muted" style={{ gap: 8 }}>
                <span>{plural(s.items.length, "payout item")}</span>·<span>{plural(s.policy?.sessions?.length ?? 0, "session")}</span>
                {s.batch_status && <><span>·</span><Status value={s.batch_status} /></>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettlementDetail() {
  const brand = useBrand();
  const { id = "" } = useParams();
  const { data: s, error, loading, reload, refresh, setData } = useApi<any>(`/api/settlements/${encodeURIComponent(id)}`, [id]);
  useMoneyRefresh((e) => e.settlement_id === id, refresh);
  const toast = useToast();
  const [replay, setReplay] = useState<any>(null);
  const [showRequest, setShowRequest] = useState(false);
  const [trail, setTrail] = useState<string | null>(null);
  if (loading && !s) return <div className="page"><Loading /></div>;
  if (error || !s) return <div className="page"><ErrorBox error={error ?? "Unknown settlement"} /></div>;
  const cur = s.currency;
  const checks = s.policy?.checks ?? [];
  const n = s.items.length;
  const total = money(s.planned_minor, cur);
  const receivers = (
    <div className="summary">
      {s.items.map((i: any) => (
        <div key={i.sender_item_id} className="line-row">
          <span className="row" style={{ gap: 6, minWidth: 0 }}><BrandIcon name="github" size={13} />{i.repo.replace("github.com/", "")}<span className="muted small">{i.receiver}</span></span>
          <strong className="num">{moneyStr(i.amount, cur)}</strong>
        </div>
      ))}
      <div className="line-row"><span className="muted">Held for unclaimed repos (not sent)</span><span className="num">{money(s.reserved_minor, cur)}</span></div>
      <div className="line-row"><span className="muted">Fee reserve (actual PayPal fees read back)</span><span className="num">{money(s.fee_reserve_minor, cur)}</span></div>
    </div>
  );
  const failed = s.status === "failed" || s.batch_status === "DENIED";
  const stage = s.status === "draft" ? 0 : s.status === "approved" || s.status === "sending" ? 1 : s.batch_status === "SUCCESS" ? 4 : 2;

  const itemCols: ColDef<any>[] = [
    {
      headerName: "Repository", field: "repo", minWidth: 220,
      cellRenderer: (p: any) => (
        <button className="btn ghost sm" style={{ paddingLeft: 0 }} title="Why this amount?" onClick={() => setTrail(p.value)}>
          <BrandIcon name="github" size={13} mono />{p.value.replace("github.com/", "")}<Route size={12} color="var(--muted)" />
        </button>
      ),
    },
    { headerName: "Receiver", field: "receiver", minWidth: 170 },
    { headerName: "Amount", field: "amount", maxWidth: 130, type: "numericColumn", cellClass: "num", valueFormatter: (p) => moneyStr(p.value, cur) },
    { headerName: "PayPal status", field: "transaction_status", maxWidth: 160, cellRenderer: (p: any) => <Status value={p.value ?? (s.status === "sent" ? "PENDING" : null)} /> },
    { headerName: "Fee (PayPal)", field: "fee", maxWidth: 130, type: "numericColumn", cellClass: "num", valueFormatter: (p) => (p.value != null ? moneyStr(p.value, cur) : "—") },
    { headerName: "Payout item", field: "payout_item_id", maxWidth: 170, cellClass: "mono", valueFormatter: (p) => shortId(p.value, 12) },
    { headerName: "sender_item_id", field: "sender_item_id", minWidth: 200, cellClass: "mono" },
    {
      headerName: "",
      field: "transaction_status",
      colId: "actions",
      maxWidth: 150,
      sortable: false,
      filter: false,
      cellRenderer: (p: any) =>
        p.value === "UNCLAIMED" ? (
          <ActionButton
            className="btn sm danger"
            confirm={{
              title: "Cancel this unclaimed payout?",
              body: <p>PayPal returns <strong>{moneyStr(p.data.amount, cur)}</strong> to the pool. {brand} holds it for <strong>{p.data.repo.replace("github.com/", "")}</strong> and flags the claim so the maintainer can fix their PayPal email.</p>,
              confirmLabel: `Cancel ${moneyStr(p.data.amount, cur)} payout`,
              tone: "danger",
              icon: <Ban size={17} />,
            }}
            onRun={async () => {
              await api(`/api/payout-items/${encodeURIComponent(p.data.sender_item_id)}/cancel`, { body: {}, admin: true });
              toast("Cancelled in PayPal. The money is back in the pool and held for this repo.");
              await reload();
            }}
          >
            <Ban size={13} />Cancel
          </ActionButton>
        ) : null,
    },
  ];
  const allocCols: ColDef<any>[] = [
    { headerName: "Package", field: "package", minWidth: 150 },
    {
      headerName: "Repository", field: "repo", minWidth: 200,
      cellRenderer: (p: any) => p.value ? <button className="btn ghost sm" style={{ paddingLeft: 0 }} title="Why this amount?" onClick={() => setTrail(p.value)}>{p.value.replace("github.com/", "")}<Route size={12} color="var(--muted)" /></button> : "—",
    },
    { headerName: "Amount", field: "amount", maxWidth: 130, type: "numericColumn", cellClass: "num", valueFormatter: (p) => moneyStr(p.value, cur) },
    { headerName: "State", field: "status", maxWidth: 140, cellRenderer: (p: any) => <Status value={p.value} /> },
    { headerName: "Becomes", field: "target", maxWidth: 120 },
    { headerName: "Held until", field: "expires_at", maxWidth: 150, valueFormatter: (p) => (p.value ? dateTime(p.value) : "—") },
    { headerName: "Sessions", field: "session_ids", valueFormatter: (p) => (p.value ?? []).length },
  ];

  return (
    <div className="page">
      <Link to="/settlements" className="back-link"><ArrowLeft size={14} />All payouts</Link>
      <PageHead
        title={<span className="row" style={{ gap: 10 }}>Payout {dateTime(s.created_at)} <Status value={s.status} /></span>}
        subtitle={<>Reference <code>{s.sender_batch_id}</code>{s.payout_batch_id && <> · PayPal batch <code>{s.payout_batch_id}</code></>}</>}
        actions={
          <>
            {s.status === "draft" && (
              <>
                <ActionButton
                  className="btn"
                  confirm={{ title: "Discard this draft?", body: <p>Nothing has been sent. The draft's allocations are deleted, and you can plan again at any time.</p>, confirmLabel: "Discard draft", tone: "danger", icon: <X size={17} /> }}
                  onRun={async () => { await api("/api/settlements/discard-drafts", { body: {}, admin: true }); toast("Draft discarded."); history.back(); }}
                >
                  <X size={15} />Discard
                </ActionButton>
                <ActionButton
                  className="btn primary"
                  disabled={checks.some((c: any) => !c.ok)}
                  title={checks.some((c: any) => !c.ok) ? "A policy check failed; see Policy checks" : undefined}
                  confirm={{
                    title: n ? `Approve ${total} to ${n} maintainer${n === 1 ? "" : "s"}?` : "Approve this run?",
                    body: <div className="stack"><p>Approving freezes the exact PayPal request and earmarks the money. Nothing is sent until you press <strong>Send with PayPal Payouts</strong>.</p>{receivers}</div>,
                    confirmLabel: n ? `Approve ${total}` : "Approve",
                    icon: <CheckCheck size={17} />,
                  }}
                  onRun={async () => {
                    const r = await api<any>(`/api/settlements/${id}/approve`, { body: {}, admin: true });
                    setData(r);
                    toast(r.status === "held" ? "Approved. Nothing to send: the shares are held for unclaimed repos." : "Approved. Allocations are now earmarked.");
                  }}
                >
                  <CheckCheck size={15} />Approve {n ? total : ""}
                </ActionButton>
              </>
            )}
            {(s.status === "approved" || s.status === "sending") && (
              <ActionButton
                className="btn paypal"
                confirm={{
                  title: `Send ${total} to ${n} maintainer${n === 1 ? "" : "s"} with PayPal?`,
                  body: (
                    <div className="stack">
                      <p>This calls <code>POST /v1/payments/payouts</code> with <code>sender_batch_id {s.sender_batch_id}</code>. Money leaves the pool. If the network fails, retrying is safe: PayPal completes a batch id only once.</p>
                      {receivers}
                    </div>
                  ),
                  confirmLabel: <><BrandIcon name="paypal" size={15} mono />Send {total}</>,
                  tone: "paypal",
                  icon: <Send size={17} />,
                }}
                onRun={async () => { const r = await api<any>(`/api/settlements/${id}/execute`, { body: {}, admin: true }); setData(r.settlement); toast(`PayPal accepted batch ${r.result.payout_batch_id}.`); }}
              >
                <BrandIcon name="paypal" size={15} mono />{s.status === "sending" ? "Retry send (same batch id)" : `Send ${total} with PayPal Payouts`}
              </ActionButton>
            )}
            {s.status === "sent" && (
              <>
                <ActionButton className="btn" onRun={async () => { const r = await api<any>(`/api/settlements/${id}/sync`, { body: {}, admin: true }); setData(r.settlement); toast(`Batch ${r.result.batch_status}; ${plural(r.result.matched, "item")} updated.`); }}>
                  <RefreshCw size={15} />Sync from PayPal
                </ActionButton>
                <ActionButton className="btn" title="Re-send the identical batch to prove PayPal rejects a reused sender_batch_id" onRun={async () => setReplay(await api(`/api/settlements/${id}/replay`, { body: {}, admin: true }))}>
                  <Repeat2 size={15} />Replay batch
                </ActionButton>
              </>
            )}
          </>
        }
      />

      {s.status === "held" ? (
        <div className="callout amber">
          <Hourglass size={18} color="var(--amber)" />
          <div>Approved with nothing to send: every share in this run is held for repositories whose maintainer hasn't verified yet. PayPal was not called. The money goes out in a later run once a maintainer verifies, or returns to the pool when the hold expires.</div>
        </div>
      ) : (
        <div className="card card-pad">
          <Stepper steps={["Draft: review checks", "Approved: request frozen", "Sent to PayPal", "Settled by PayPal"]} current={failed ? Math.max(stage, 2) : stage} failed={failed} />
        </div>
      )}

      {s.error && (
        <ErrorBox error={s.error.retryable ? `Last attempt hit a network or 5xx error. Retrying is safe: ${s.error.message}` : `PayPal ${s.error.status ?? ""}: ${JSON.stringify(s.error.body ?? s.error)}`} />
      )}

      {["approved", "sending", "sent", "held"].includes(s.status) && (
        <Card title="Watch this payout" sub="Moves when PayPal confirms each step" icon={<Send size={17} />} tone="teal">
          <BatchFlow settlement={s} />
        </Card>
      )}

      <div className="grid-4">
        <Box label="Pool available at planning" value={money(s.pool_minor, cur)} />
        <Box label="To verified maintainers" value={money(s.planned_minor, cur)} tone="var(--teal)" />
        <Box label="Held for unclaimed repos" value={money(s.reserved_minor, cur)} tone="var(--amber)" />
        <Box label="Fee reserve (actual fees read back)" value={money(s.fee_reserve_minor, cur)} />
      </div>

      <div className="split">
        <Card title="Payout items" sub="One item per verified repository" icon={<Send size={17} />} tone="teal" actions={s.request && <button className="btn ghost sm" onClick={() => setShowRequest(true)}><FileJson size={14} />Request JSON</button>}>
          {s.items.length ? <Grid rows={s.items} columns={itemCols} height={Math.min(120 + s.items.length * 44, 420)} getRowId={(r) => r.sender_item_id} /> : <Empty icon={<Hourglass size={22} />} title="No payable items">All allocations in this run are held until a maintainer claims the repo.</Empty>}
        </Card>
        <Card title="Policy checks" sub="Enforced in code before PayPal is ever called" icon={<ShieldCheck size={17} />} tone="green">
          {checks.map((c: any) => <CheckRow key={c.id} ok={c.ok} label={c.label} detail={c.detail} />)}
          {s.policy?.unpayable?.length > 0 && (
            <div className="callout amber" style={{ marginTop: 10 }}>
              <ListChecks size={16} color="var(--amber)" />
              <div className="small">
                {s.policy.unpayable.map((u: any) => <div key={u.package}><strong>{u.package}</strong>: {u.reason} ({money(u.amount_minor, cur)} stays in the pool)</div>)}
              </div>
            </div>
          )}
        </Card>
      </div>

      {s.policy?.held_for_fees?.length > 0 && (
        <Card title="Held to save fees" sub="These maintainers are verified, but paying them now would cost too much of the payout. The money waits for them and goes out once it reaches the amount shown." icon={<Hourglass size={17} />} tone="amber">
          <div className="summary">
            {s.policy.held_for_fees.map((h: any) => (
              <div key={h.repo} className="line-row">
                <span style={{ minWidth: 0 }}>
                  <strong>{h.repo.replace("github.com/", "")}</strong> · {money(h.held_minor, cur)} held · paying now would lose {pct(h.fee_share_if_paid_now)} to PayPal's {money(h.fee_estimate_minor, cur)} fee · pays out at {money(h.threshold_minor, cur)}
                </span>
                <span className="muted small" style={{ flex: "none" }}>{h.estimate_source === "paypal" ? "PayPal's last fee" : "Default estimate"}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Allocations" sub="Earmarks inside the pool: what this run pays, holds, or carries over" icon={<ListChecks size={17} />}>
        <Grid rows={s.allocations} columns={allocCols} height={Math.min(120 + s.allocations.length * 44, 460)} getRowId={(r) => r.id} />
      </Card>

      {replay && (
        <Modal
          width={720}
          title={replay.rejected ? "PayPal rejected the duplicate batch" : "PayPal accepted the replay"}
          sub={`Same body and sender_batch_id, new PayPal-Request-Id · HTTP ${replay.status}${replay.debug_id ? ` · debug ${replay.debug_id}` : ""}`}
          icon={<Braces size={17} />}
          tone={replay.rejected ? "green" : "red"}
          onClose={() => setReplay(null)}
        >
          <pre className="json">{JSON.stringify(replay.body, null, 2)}</pre>
        </Modal>
      )}
      {showRequest && (
        <Modal width={720} title="POST /v1/payments/payouts" sub="Frozen at approval so every retry is byte-identical" icon={<FileJson size={17} />} onClose={() => setShowRequest(false)}>
          <pre className="json">{JSON.stringify(s.request, (k, v) => (k === "receiver" ? String(v).replace(/^(.).*(@.*)$/, "$1•••$2") : v), 2)}</pre>
        </Modal>
      )}
      {trail && <TrailDrawer repo={trail} onClose={() => setTrail(null)} />}
    </div>
  );
}

function Box({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card stat" style={{ padding: 16 }}>
      <div className="muted small">{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 650, color: tone }}>{value}</div>
    </div>
  );
}
