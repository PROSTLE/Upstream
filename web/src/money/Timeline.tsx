// The money timeline on the Money records page, drawn with Bryntum Scheduler (Community edition, MIT licensed).
// One row for your budget and one per repository. Every bar is a stored record: a payment PayPal confirmed, a payout,
// a share held for a maintainer who hasn't claimed yet, or what's scheduled next. It's read-only, and this module is
// loaded only on that page, so the rest of the app never downloads Bryntum.
import { useEffect, useMemo } from "react";
import { BryntumScheduler } from "@bryntum/scheduler-react-community";
import "@bryntum/core-community/fontawesome/css/fontawesome.css";
import "@bryntum/core-community/fontawesome/css/solid.css";
import "@bryntum/scheduler-community/scheduler.css";
import lightTheme from "@bryntum/scheduler-community/svalbard-light.css?url";
import darkTheme from "@bryntum/scheduler-community/svalbard-dark.css?url";
import { CalendarClock } from "lucide-react";
import { useApi } from "../api.ts";
import { dateTime, money, shortId } from "../format.ts";
import { useResolvedTheme } from "../theme.ts";
import { Empty, ErrorBox, Loading } from "../ui.tsx";

type Kind = "payment_in" | "next_payment" | "held" | "in_flight" | "unclaimed" | "paid" | "released";

interface TimelineData {
  rows: { id: string; name: string; kind: "budget" | "repo"; verified: boolean; packages: string[] }[];
  events: {
    id: string;
    resourceId: string;
    kind: Kind;
    start: string;
    end: string;
    amount_minor: number;
    currency: string;
    upcoming: boolean;
    ref: { batch?: string | null; transaction?: string | null; subscription?: string | null; memo?: string | null };
  }[];
  window: { start: string; end: string };
  now: string;
  policy: { reserve_days: number; cancel_unclaimed_after_days: number };
}

const DAY = 24 * 3600 * 1000;

// The same colours as the money diagram above (data.tsx chartPalette): teal is paid, amber is held, blue is at PayPal, violet is money in.
const KINDS: Record<Kind, { label: string; color: string }> = {
  payment_in: { label: "Payment in", color: "#6d4ae0" },
  next_payment: { label: "Next payment", color: "#6d4ae0" },
  held: { label: "Held", color: "#c27803" },
  in_flight: { label: "At PayPal", color: "#2f5bea" },
  unclaimed: { label: "Unclaimed", color: "#c42b2b" },
  paid: { label: "Paid", color: "#0f9d94" },
  released: { label: "Back to your pool", color: "#7c8597" },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** What a bar means, in a sentence, with PayPal's ids where there are some. */
function explain(e: TimelineData["events"][number], repo: string, policy: TimelineData["policy"]): string {
  const amount = money(e.amount_minor, e.currency);
  const ids = [e.ref.batch && `Batch ${shortId(e.ref.batch, 14)}`, e.ref.transaction && `transaction ${shortId(e.ref.transaction, 18)}`].filter(Boolean).join(", ");
  switch (e.kind) {
    case "payment_in":
      return `PayPal confirmed ${amount} coming into your budget on ${dateTime(e.start)}.${e.ref.memo ? ` ${e.ref.memo}.` : ""}`;
    case "next_payment":
      return `PayPal will collect your next ${amount} on ${dateTime(e.start)}, from subscription ${e.ref.subscription}.`;
    case "held":
      return `${amount} is held for ${repo} until its maintainer proves they run the repository. If nobody does, it goes back to your pool on ${dateTime(e.end)} (${policy.reserve_days} days).`;
    case "in_flight":
      return `Sent to PayPal on ${dateTime(e.start)}. ${ids ? `${ids}. ` : ""}Waiting for PayPal's final status.`;
    case "unclaimed":
      return `PayPal sent ${amount} on ${dateTime(e.start)}, but nobody has claimed it yet. If it's still unclaimed on ${dateTime(e.end)}, ${policy.cancel_unclaimed_after_days} days later, it's cancelled and held for ${repo} again.`;
    case "paid":
      return `PayPal paid ${amount} to ${repo} on ${dateTime(e.end)}.${ids ? ` ${ids}.` : ""}`;
    case "released":
      return `Nobody claimed ${repo}, so ${amount} went back to your pool on ${dateTime(e.end)}.`;
  }
}

/** Bryntum's light and dark themes, swapped to follow the app's own theme switch. Only one is ever loaded. */
function useBryntumTheme() {
  const theme = useResolvedTheme();
  useEffect(() => {
    let link = document.getElementById("bryntum-theme") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = "bryntum-theme";
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    link.href = theme === "dark" ? darkTheme : lightTheme;
  }, [theme]);
  useEffect(() => () => document.getElementById("bryntum-theme")?.remove(), []);
}

export function MoneyTimeline() {
  useBryntumTheme();
  const { data, error, loading } = useApi<TimelineData>("/api/money/timeline", [], { poll: 60000 });

  const view = useMemo(() => {
    if (!data) return null;
    const start = Date.parse(data.window.start);
    const end = Date.parse(data.window.end);
    const span = end - start;
    // A payment or a payout is an instant; it gets a minimum width so it can be seen and hovered. The tooltip has the exact times.
    const minWidth = Math.max(DAY, span * 0.035);
    const names = new Map(data.rows.map((r) => [r.id, r.name]));
    const now = Date.parse(data.now);
    const events = data.events.map((e) => {
      const s = Date.parse(e.start);
      // Scheduled: hasn't started yet (faded). Ongoing: started and still going, such as a hold (dashed outline).
      const scheduled = s > now;
      return {
        id: e.id,
        resourceId: e.resourceId,
        startDate: new Date(s),
        endDate: new Date(Math.max(Date.parse(e.end), s + minWidth)),
        name: `${KINDS[e.kind].label} ${money(e.amount_minor, e.currency)}`,
        eventColor: KINDS[e.kind].color,
        scheduled,
        ongoing: !scheduled && e.upcoming,
        info: explain(e, names.get(e.resourceId) ?? e.resourceId, data.policy),
      };
    });
    const resources = data.rows.map((r) => ({ id: r.id, name: r.kind === "budget" ? r.name : `${r.name}${r.verified ? "  ✓" : ""}` }));
    const preset = span <= 16 * DAY ? "weekAndDay" : span <= 150 * DAY ? "weekDateAndMonth" : "monthAndYear";
    return { events, resources, start: new Date(start), end: new Date(end), preset };
  }, [data]);

  if (loading && !data) return <Loading rows={3} />;
  if (error || !data || !view) return <ErrorBox error={error ?? "Could not load the timeline"} />;
  if (!view.resources.length) {
    return <Empty icon={<CalendarClock size={22} />} title="Nothing on the timeline yet">Payments in, payouts and held shares appear here as PayPal confirms them.</Empty>;
  }
  const used = new Set(data.events.map((e) => e.kind));
  return (
    <div className="timeline">
      <BryntumScheduler
        readOnly
        autoHeight
        startDate={view.start}
        endDate={view.end}
        viewPreset={view.preset}
        rowHeight={48}
        barMargin={10}
        eventStyle="filled"
        resources={view.resources}
        events={view.events}
        columns={[{ text: "Repository", field: "name", width: 230 }]}
        eventRenderer={({ eventRecord, renderData }) => {
          const d = (eventRecord as unknown as { data: { scheduled?: boolean; ongoing?: boolean } }).data;
          const cls = (renderData as unknown as { cls: Record<string, boolean> }).cls;
          if (d.scheduled) cls["tl-scheduled"] = true;
          if (d.ongoing) cls["tl-ongoing"] = true;
          return eventRecord.name;
        }}
        eventTooltipFeature={{
          template: ({ eventRecord }: { eventRecord: { name: string; data: { info: string } } }) => `<div class="tl-tip"><b>${esc(eventRecord.name)}</b><p>${esc(eventRecord.data.info)}</p></div>`,
        }}
        eventDragFeature={false}
        eventResizeFeature={false}
        eventDragCreateFeature={false}
        eventEditFeature={false}
        eventMenuFeature={false}
        scheduleMenuFeature={false}
        cellMenuFeature={false}
        headerMenuFeature={false}
        timeAxisHeaderMenuFeature={false}
        scheduleTooltipFeature={false}
        sortFeature={false}
        zoomOnMouseWheel={false}
        zoomOnTimeAxisDoubleClick={false}
      />
      <div className="tl-legend" aria-label="What the colours mean">
        {(Object.keys(KINDS) as Kind[]).filter((k) => used.has(k)).map((k) => (
          <span key={k}><i style={{ background: KINDS[k].color, opacity: k === "next_payment" ? 0.45 : 1 }} />{KINDS[k].label}{k === "next_payment" ? " (scheduled)" : ""}</span>
        ))}
        <span className="muted">Dashed: still going. Faded: scheduled, not happened yet. Today is {dateTime(data.now).split(",")[0]}.</span>
      </div>
    </div>
  );
}
