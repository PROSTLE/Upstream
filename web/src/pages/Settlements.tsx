import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Ban, Braces, CheckCheck, FileJson, HandCoins, Hourglass, ListChecks, RefreshCw, Repeat2, Send, ShieldCheck, X,
} from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { api, useApi } from "../api.ts";
import { dateTime, money, moneyStr, shortId } from "../format.ts";
import { ActionButton, BrandIcon, Card, CheckRow, Empty, ErrorBox, Loading, PageHead, Status, useToast } from "../ui.tsx";
import { Grid } from "../data.tsx";

export function Settlements() {
  const { data, error, loading } = useApi<any[]>("/api/settlements");
  const nav = useNavigate();
  const toast = useToast();
  return (
    <div className="page">
      <PageHead
        title="Payouts"
        subtitle="Each settlement becomes one PayPal Payouts batch with a fixed sender_batch_id. You approve it; code enforces the budget, caps and verified receivers."
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
          <Empty icon={<Send size={22} />} title="No payouts yet">
            Attribute a session, make sure at least one maintainer has claimed their repo, then plan a payout.
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
                <span>{s.items.length} payout item(s)</span>·<span>{s.policy?.sessions?.length ?? 0} session(s)</span>
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
  const { id = "" } = useParams();
  const { data: s, error, loading, reload, setData } = useApi<any>(`/api/settlements/${encodeURIComponent(id)}`, [id]);
  const toast = useToast();
  const [replay, setReplay] = useState<any>(null);
  const [showRequest, setShowRequest] = useState(false);
  if (loading && !s) return <div className="page"><Loading /></div>;
  if (error || !s) return <div className="page"><ErrorBox error={error ?? "Unknown settlement"} /></div>;
  const cur = s.currency;
  const checks = s.policy?.checks ?? [];

  const itemCols: ColDef<any>[] = [
    { headerName: "Repository", field: "repo", minWidth: 220, cellRenderer: (p: any) => <span className="row" style={{ gap: 6, height: "100%" }}><BrandIcon name="github" size={13} mono />{p.value.replace("github.com/", "")}</span> },
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
    { headerName: "Repository", field: "repo", minWidth: 200, valueFormatter: (p) => p.value?.replace("github.com/", "") ?? "—" },
    { headerName: "Amount", field: "amount", maxWidth: 130, type: "numericColumn", cellClass: "num", valueFormatter: (p) => moneyStr(p.value, cur) },
    { headerName: "State", field: "status", maxWidth: 140, cellRenderer: (p: any) => <Status value={p.value} /> },
    { headerName: "Becomes", field: "target", maxWidth: 120 },
    { headerName: "Held until", field: "expires_at", maxWidth: 150, valueFormatter: (p) => (p.value ? dateTime(p.value) : "—") },
    { headerName: "Sessions", field: "session_ids", valueFormatter: (p) => (p.value ?? []).length },
  ];

  return (
    <div className="page">
      <Link to="/settlements" className="row muted small" style={{ gap: 6 }}><ArrowLeft size={14} />All payouts</Link>
      <PageHead
        title={<span className="row" style={{ gap: 10 }}>Payout {dateTime(s.created_at)} <Status value={s.status} /></span>}
        subtitle={<>sender_batch_id <code>{s.sender_batch_id}</code>{s.payout_batch_id && <> · PayPal batch <code>{s.payout_batch_id}</code></>}</>}
        actions={
          <>
            {s.status === "draft" && (
              <>
                <ActionButton className="btn" onRun={async () => { await api("/api/settlements/discard-drafts", { body: {}, admin: true }); toast("Draft discarded."); history.back(); }}>
                  <X size={15} />Discard
                </ActionButton>
                <ActionButton className="btn primary" disabled={checks.some((c: any) => !c.ok)} onRun={async () => { setData(await api(`/api/settlements/${id}/approve`, { body: {}, admin: true })); toast("Approved. Allocations are now earmarked."); }}>
                  <CheckCheck size={15} />Approve
                </ActionButton>
              </>
            )}
            {(s.status === "approved" || s.status === "sending") && (
              <ActionButton className="btn primary" onRun={async () => { const r = await api<any>(`/api/settlements/${id}/execute`, { body: {}, admin: true }); setData(r.settlement); toast(`PayPal accepted batch ${r.result.payout_batch_id}.`); }}>
                <BrandIcon name="paypal" size={15} mono />{s.status === "sending" ? "Retry send (same batch id)" : "Send with PayPal Payouts"}
              </ActionButton>
            )}
            {s.status === "sent" && (
              <>
                <ActionButton className="btn" onRun={async () => { const r = await api<any>(`/api/settlements/${id}/sync`, { body: {}, admin: true }); setData(r.settlement); toast(`Batch ${r.result.batch_status}; ${r.result.matched} item(s) updated.`); }}>
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

      {s.error && (
        <ErrorBox error={s.error.retryable ? `Last attempt hit a network or 5xx error. Retrying is safe: ${s.error.message}` : `PayPal ${s.error.status ?? ""}: ${JSON.stringify(s.error.body ?? s.error)}`} />
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

      <Card title="Allocations" sub="Earmarks inside the pool: what this run pays, holds, or carries over" icon={<ListChecks size={17} />}>
        <Grid rows={s.allocations} columns={allocCols} height={Math.min(120 + s.allocations.length * 44, 460)} getRowId={(r) => r.id} />
      </Card>

      {replay && (
        <div className="modal-back" onClick={() => setReplay(null)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <div className={`icon-tile ${replay.rejected ? "green" : "red"}`}><Braces size={17} /></div>
              <div>
                <h2>{replay.rejected ? "PayPal rejected the duplicate batch" : "PayPal accepted the replay"}</h2>
                <div className="sub">Same body and sender_batch_id, new PayPal-Request-Id · HTTP {replay.status}{replay.debug_id ? ` · debug ${replay.debug_id}` : ""}</div>
              </div>
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => setReplay(null)}><X size={16} /></button>
            </div>
            <div className="card-body"><pre className="json">{JSON.stringify(replay.body, null, 2)}</pre></div>
          </div>
        </div>
      )}
      {showRequest && (
        <div className="modal-back" onClick={() => setShowRequest(false)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <div className="icon-tile"><FileJson size={17} /></div>
              <div><h2>POST /v1/payments/payouts</h2><div className="sub">Frozen at approval so every retry is byte-identical</div></div>
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => setShowRequest(false)}><X size={16} /></button>
            </div>
            <div className="card-body"><pre className="json">{JSON.stringify(s.request, (k, v) => (k === "receiver" ? String(v).replace(/^(.).*(@.*)$/, "$1•••$2") : v), 2)}</pre></div>
          </div>
        </div>
      )}
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
