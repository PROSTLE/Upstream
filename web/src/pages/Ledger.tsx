import { ArrowLeftRight, History, PieChart } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { useApi } from "../api.ts";
import { dateTime, money, moneyStr } from "../format.ts";
import { Card, Empty, ErrorBox, Loading, PageHead } from "../ui.tsx";
import { Chart, Grid } from "../data.tsx";
import { FlowDiagram } from "./Overview.tsx";

const KIND: Record<string, string> = {
  FUNDING_GROSS: "Subscription payment",
  FUNDING_FEE: "PayPal fee (funding)",
  PAYOUT_SENT: "Payout to maintainer",
  PAYOUT_FEE: "PayPal fee (payout)",
  PAYOUT_RETURNED: "Payout returned / cancelled",
};

export function Ledger() {
  const { data, error, loading } = useApi<any>("/api/ledger");
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorBox error={error ?? "Could not load ledger"} /></div>;
  const p = data.summary;
  const cur = p.currency;

  const cols: ColDef<any>[] = [
    { headerName: "When", field: "occurred_at", maxWidth: 170, sort: "desc", valueFormatter: (x) => dateTime(x.value) },
    { headerName: "Entry", field: "kind", minWidth: 200, valueFormatter: (x) => KIND[x.value] ?? x.value },
    { headerName: "Amount", field: "amount", maxWidth: 150, type: "numericColumn", cellClass: "num", valueFormatter: (x) => moneyStr(x.value, x.data.currency), cellStyle: (x: any) => ({ color: Number(x.value) < 0 ? "var(--red)" : "var(--green)", fontWeight: 600 }) as any },
    { headerName: "Reference", field: "ref_id", minWidth: 200, cellClass: "mono" },
    { headerName: "Memo", field: "memo", flex: 2, minWidth: 220 },
    { headerName: "Source", field: "source", maxWidth: 130, valueFormatter: (x) => (x.value === "webhook" ? "Webhook" : "PayPal API") },
  ];
  const callCols: ColDef<any>[] = [
    { headerName: "When", field: "at", maxWidth: 170, valueFormatter: (x) => dateTime(x.value) },
    { headerName: "Call", valueGetter: (x) => `${x.data.method} ${x.data.path}`, minWidth: 320, cellClass: "mono" },
    { headerName: "HTTP", field: "status", maxWidth: 100, cellStyle: (x: any) => ({ color: x.value && x.value < 300 ? "var(--green)" : "var(--red)", fontWeight: 600 }) as any },
    { headerName: "PayPal-Request-Id", field: "request_id", minWidth: 200, cellClass: "mono" },
    { headerName: "Debug id", field: "debug_id", maxWidth: 170, cellClass: "mono" },
    { headerName: "Error", field: "error_name", maxWidth: 220 },
    { headerName: "ms", field: "duration_ms", maxWidth: 90, type: "numericColumn" },
  ];

  const donut = [
    { k: "Paid to maintainers", v: -p.payoutsSent - p.returned },
    { k: "PayPal fees", v: -p.fundingFees - p.payoutFees },
    { k: "Held for unclaimed", v: p.reserved },
    { k: "In flight", v: p.inFlight },
    { k: "Available", v: p.available },
  ].filter((d) => d.v > 0).map((d) => ({ ...d, label: money(d.v, cur) }));

  return (
    <div className="page">
      <PageHead title="Ledger" subtitle="Only movements PayPal has confirmed: subscription transactions, payout item statuses and fees, returns. Webhooks and the hourly reconciler write the same idempotent entries." />
      <div className="split">
        <Card title="Flow of funds" icon={<ArrowLeftRight size={17} />}>
          {p.fundingGross === 0 ? <Empty icon={<ArrowLeftRight size={22} />} title="No money has moved yet" /> : <FlowDiagram pool={p} />}
        </Card>
        <Card title="Breakdown" icon={<PieChart size={17} />} tone="violet">
          {donut.length === 0 ? <Empty icon={<PieChart size={22} />} title="Nothing to chart yet" /> : (
            <Chart
              height={280}
              options={{
                data: donut,
                series: [{ type: "donut", angleKey: "v", legendItemKey: "k", innerRadiusRatio: 0.68, calloutLabelKey: "label", calloutLabel: { enabled: false }, tooltip: { renderer: ({ datum }: any) => ({ title: datum.k, content: datum.label }) } }],
                legend: { position: "right" },
              } as any}
            />
          )}
        </Card>
      </div>
      <Card title="Entries" icon={<ArrowLeftRight size={17} />} tone="teal">
        <Grid rows={data.entries} columns={cols} height={420} getRowId={(r) => String(r.id)} />
      </Card>
      <Card title="PayPal API audit log" sub="Every call Upstream made, with PayPal-Request-Id and PayPal-Debug-Id" icon={<History size={17} />}>
        <Grid rows={data.paypal_calls} columns={callCols} height={380} getRowId={(r) => String(r.id)} />
      </Card>
    </div>
  );
}
