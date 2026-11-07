// The board /insights opens with: a Money page and an Attribution page, as AG Studio report state.
// Field ids ('ledger.money_in') refer to the data sources in ./data.ts; 'calendar::month' is the shared calendar.
// report.json is this state as Studio itself saves it (api.getState() in a development build, where
// Insights.tsx exposes the API as window.__insightsApi), and is what the page loads. Regenerate it after editing here.
import type { AgPageState, AgReportState, AgWidgetLayoutState } from "ag-studio";
import type { UpstreamRegistry } from "./widgets/types.ts";

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle && { subtitle: { enabled: true, text: subtitle } }),
});
const sum = (id: string) => ({ id, aggregation: "sum" as const });
const kpi = (text: string, field: string, caption: string) => ({
  type: "value" as const,
  dataMapping: { value: [sum(field)] },
  format: { title: { enabled: true, text }, caption: { enabled: true, text: caption } },
});

export const PAGES = [
  { id: "money", label: "Money" },
  { id: "attribution", label: "Attribution" },
] as const;

const money: AgPageState<UpstreamRegistry> = {
  id: "money",
  widgets: {
    "kpi-in": kpi("Funds in", "ledger.money_in", "Confirmed by PayPal"),
    "kpi-paid": kpi("Paid out", "ledger.paid_out", "Sent to verified maintainers"),
    "kpi-held": kpi("Held for unclaimed", "allocations.held_amount", "Waiting for a maintainer to verify"),
    "kpi-fees": kpi("PayPal fees", "ledger.fees", "On money in and on payouts"),
    "by-month": {
      type: "column-chart-grouped",
      dataMapping: { categoryKey: [{ id: "calendar::month" }], valueKey: [sum("ledger.money_in"), sum("ledger.paid_out"), sum("ledger.fees")] },
      format: { ...title("Money in and out by month", "PayPal-confirmed ledger entries"), style: { theme: { common: { legend: { enabled: true } } } } },
    },
    trail: {
      type: "money-trail",
      dataMapping: {
        repo: [{ id: "maintainers.repo" }],
        held: [sum("allocations.held_amount")],
        sent: [sum("allocations.sent_amount")],
        paid: [sum("allocations.paid_amount")],
        claim: [{ id: "maintainers.status", aggregation: "first" }],
        paypal: [{ id: "maintainers.paypal_status", aggregation: "first" }],
        expires: [{ id: "maintainers.hold_expires_at", aggregation: "first" }],
      },
      format: { style: { heading: "Money trail", maxRows: 8 }, crossFilter: "highlight" },
    },
    payouts: {
      type: "grid",
      dataMapping: {
        cols: [
          { id: "payouts.repo" },
          { id: "payouts.transaction_status" },
          { id: "payouts.status_changed_at" },
          sum("payouts.amount"),
          sum("payouts.fee"),
        ],
      },
      sort: [{ field: { id: "payouts.status_changed_at" }, direction: "desc" }],
      format: title("Payouts", "One row per PayPal payout item, with PayPal's own status and fee"),
    },
  },
  widgetLayout: {
    "kpi-in": at(0, 0, 6, 6),
    "kpi-paid": at(6, 0, 6, 6),
    "kpi-held": at(12, 0, 6, 6),
    "kpi-fees": at(18, 0, 6, 6),
    "by-month": at(0, 6, 13, 18),
    trail: at(13, 6, 11, 18),
    payouts: at(0, 24, 24, 13),
  },
};

const attribution: AgPageState<UpstreamRegistry> = {
  id: "attribution",
  widgets: {
    dvu: {
      type: "declared-vs-used",
      dataMapping: {
        package: [{ id: "shares.package" }],
        listed: [sum("shares.manifest_share")],
        used: [sum("shares.llm_share")],
        sessions: [{ id: "shares.session_id", aggregation: "countd" }],
      },
      format: { style: { heading: "Declared vs used", showNeverUsed: true, maxRows: 10 }, crossFilter: "highlight" },
    },
    "top-packages": {
      type: "bar-chart-grouped",
      dataMapping: { categoryKey: [{ id: "shares.package" }], valueKey: [sum("shares.llm_share")] },
      sort: [{ field: sum("shares.llm_share"), direction: "desc" }],
      format: title("Top packages by Upstream share", "Each session's share, added up across sessions"),
    },
    "alloc-pivot": {
      type: "pivot-grid",
      dataMapping: { rows: [{ id: "allocations.package" }], columns: [{ id: "calendar::month" }], values: [sum("allocations.amount")] },
      format: title("Earmarked by package and month", "Allocations from payout runs"),
    },
    sessions: {
      type: "grid",
      dataMapping: {
        cols: [
          { id: "sessions.project" },
          { id: "sessions.started_at" },
          { id: "sessions.status" },
          sum("sessions.evidence_count"),
          sum("sessions.packages_used"),
        ],
      },
      sort: [{ field: { id: "sessions.started_at" }, direction: "desc" }],
      format: title("Coding sessions", "Recorded by the hook, reviewed by Muse Spark"),
    },
  },
  // Like the accuracy page, compare the two methods only on sessions that have both.
  filter: { widget: { dvu: [{ field: { id: "shares.comparable" }, model: { operator: "isTrue" } }] } },
  widgetLayout: {
    dvu: at(0, 0, 12, 22),
    "top-packages": at(12, 0, 12, 22),
    "alloc-pivot": at(0, 22, 12, 16),
    sessions: at(12, 22, 12, 16),
  },
};

export const defaultReport: AgReportState<UpstreamRegistry> = {
  selectedPageId: "money",
  pages: [money, attribution],
  panels: { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true } },
};
