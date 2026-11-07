// Upstream's AG Studio widgets, added to Studio's own menu under "Upstream". Both define `formatShape`
// and `ai`, so Studio's agents can find, place and configure them like built-in widgets.
import type { AgCoreDefaultRegistry, AgWidgetFormParams, AgWidgetsConfig } from "ag-studio";
import { createWidgets } from "ag-studio-react";
import DeclaredVsUsed from "./DeclaredVsUsed.tsx";
import MoneyTrail from "./MoneyTrail.tsx";
import { crossFilterProps, shapeBuilder } from "./shape.ts";
import type { DeclaredVsUsedDef, MoneyTrailDef, UpstreamRegistry } from "./types.ts";

const ICON_DUMBBELL =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 7h10M9 12h9M4 17h8"/><circle cx="6" cy="7" r="2" fill="currentColor"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="12" r="2" fill="currentColor"/><circle cx="18" cy="12" r="2"/><circle cx="4" cy="17" r="2" fill="currentColor"/><circle cx="12" cy="17" r="2"/></svg>';
const ICON_TRAIL =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="4" rx="2"/><rect x="3" y="15" width="12" height="4" rx="2"/><path d="M9 5v4M15 5v4M8 15v4"/></svg>';

type Form = AgWidgetFormParams<any>;

/** The stock setup tab (widget type, data mapping, cross filtering) and our own format section. */
function form(p: Form, items: { key: string; label: string }[], formatItems: unknown[]) {
  const defaults = p.createDefaults({ dataMappingItems: items as never, supportsCrossHighlight: true }) as any;
  const setup = [p.createWidgetSection(), p.createDataMapping(items as never), p.createCrossFilterSection(true, true)].filter(Boolean);
  defaults.items[0].items = setup;
  defaults.items[1].items = [{ type: "section", key: "upstream", label: "Display", defaultExpanded: true, items: formatItems }];
  return defaults;
}

const declaredVsUsed = {
  id: "declared-vs-used" as const,
  label: "Declared vs used",
  icon: ICON_DUMBBELL,
  dataMapping: {
    package: { type: "field", supportedRoles: ["category"], requires: { cardinality: "many" }, required: true, aiDescription: "The package to compare (shares.package)." },
    listed: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.package", cardinality: "one" }, required: true, aiDescription: "Sum of the dependency-list share per package (shares.manifest_share, aggregation sum)." },
    used: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.package", cardinality: "one" }, required: true, aiDescription: "Sum of Upstream's evidence-based share per package (shares.llm_share, aggregation sum)." },
    sessions: { type: "field", supportedRoles: ["numeric"], requires: { cardinality: "one" }, required: true, aiDescription: "Number of distinct sessions in view (shares.session_id, aggregation countd); turns the sums into shares of all session budgets." },
  },
  defaultState: {
    dataMapping: {
      package: [{ id: "shares.package" }],
      listed: [{ id: "shares.manifest_share", aggregation: "sum" }],
      used: [{ id: "shares.llm_share", aggregation: "sum" }],
      sessions: [{ id: "shares.session_id", aggregation: "countd" }],
    },
    format: { style: { heading: "Declared vs used", showNeverUsed: true, maxRows: 10 }, crossFilter: "highlight" },
  } as Partial<DeclaredVsUsedDef>,
  formatShape: (p: any) => {
    const s = shapeBuilder(p);
    return s.object({
      style: s.object({
        heading: s.string({ description: "Heading drawn at the top of the widget." }).optional(),
        showNeverUsed: s.boolean({ description: "Tag packages the dependency list pays but the agent never used." }).optional(),
        maxRows: s.number({ description: "How many packages to draw, largest first (1-30)." }).optional(),
      }).optional(),
      ...crossFilterProps(s),
    }).optional();
  },
  form: (p: Form) =>
    form(
      p,
      [
        { key: "package", label: "Package" },
        { key: "listed", label: "Dependency-list share" },
        { key: "used", label: "Upstream share" },
        { key: "sessions", label: "Sessions" },
      ],
      [
        { type: "textfield", id: "format.style.heading", label: "Heading", defaultValue: "Declared vs used" },
        { type: "toggle", id: "format.style.showNeverUsed", label: "Tag packages never used", defaultValue: true },
        { type: "number", id: "format.style.maxRows", label: "Packages shown", defaultValue: 10 },
      ],
    ),
  comp: DeclaredVsUsed,
  defaultSize: { width: 560, height: 420 },
  minSize: { width: 320, height: 220 },
  featureConfig: { crossFilter: { supportsHighlight: true } },
  ai: {
    label: "Declared vs used",
    description:
      "A dumbbell chart, one row per package: a grey dot for the share an equal split of the dependency list would give it, an accent dot for the share Upstream gives it from evidence, and a red 'never used' tag when the list pays a package the agent never used.",
    usage: "Use it to show how funding by dependency list differs from funding by what the agent actually used. It shows shares, not money amounts.",
    configuration: "package: shares.package. listed: shares.manifest_share with sum. used: shares.llm_share with sum. sessions: shares.session_id with countd.",
  },
};

const moneyTrail = {
  id: "money-trail" as const,
  label: "Money trail",
  icon: ICON_TRAIL,
  dataMapping: {
    repo: { type: "field", supportedRoles: ["category"], requires: { cardinality: "many" }, required: true, aiDescription: "The maintainer repo (maintainers.repo)." },
    held: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.repo", cardinality: "one" }, required: true, aiDescription: "Money held because the repo has no verified maintainer (allocations.held_amount, sum)." },
    sent: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.repo", cardinality: "one" }, required: true, aiDescription: "Money in a PayPal batch that has not settled (allocations.sent_amount, sum)." },
    paid: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.repo", cardinality: "one" }, required: true, aiDescription: "Money PayPal confirmed as paid (allocations.paid_amount, sum)." },
    claim: { type: "field", supportedRoles: ["category"], requires: { per: "dataMapping.repo", cardinality: "one" }, required: false, aiDescription: "Whether the maintainer proved ownership (maintainers.status)." },
    paypal: { type: "field", supportedRoles: ["category"], requires: { per: "dataMapping.repo", cardinality: "one" }, required: false, aiDescription: "PayPal's status for the repo's latest payout (maintainers.paypal_status)." },
    expires: { type: "field", supportedRoles: ["temporal"], requires: { per: "dataMapping.repo", cardinality: "one" }, required: false, aiDescription: "When the repo's held money goes back to the pool (maintainers.hold_expires_at)." },
  },
  defaultState: {
    dataMapping: {
      repo: [{ id: "maintainers.repo" }],
      held: [{ id: "allocations.held_amount", aggregation: "sum" }],
      sent: [{ id: "allocations.sent_amount", aggregation: "sum" }],
      paid: [{ id: "allocations.paid_amount", aggregation: "sum" }],
      claim: [{ id: "maintainers.status", aggregation: "first" }],
      paypal: [{ id: "maintainers.paypal_status", aggregation: "first" }],
      expires: [{ id: "maintainers.hold_expires_at", aggregation: "first" }],
    },
    format: { style: { heading: "Money trail", maxRows: 8 }, crossFilter: "highlight" },
  } as Partial<MoneyTrailDef>,
  formatShape: (p: any) => {
    const s = shapeBuilder(p);
    return s.object({
      style: s.object({
        heading: s.string({ description: "Heading drawn at the top of the widget." }).optional(),
        maxRows: s.number({ description: "How many repos to draw, most money first (1-30)." }).optional(),
      }).optional(),
      ...crossFilterProps(s),
    }).optional();
  },
  form: (p: Form) =>
    form(
      p,
      [
        { key: "repo", label: "Repo" },
        { key: "held", label: "Held" },
        { key: "sent", label: "Sent" },
        { key: "paid", label: "Paid" },
        { key: "claim", label: "Claim status" },
        { key: "paypal", label: "PayPal status" },
        { key: "expires", label: "Hold expires" },
      ],
      [
        { type: "textfield", id: "format.style.heading", label: "Heading", defaultValue: "Money trail" },
        { type: "number", id: "format.style.maxRows", label: "Repos shown", defaultValue: 8 },
      ],
    ),
  comp: MoneyTrail,
  defaultSize: { width: 560, height: 360 },
  minSize: { width: 320, height: 200 },
  featureConfig: { crossFilter: { supportsHighlight: true } },
  ai: {
    label: "Money trail",
    description:
      "One row per maintainer repo with a stacked bar of its money: held (no verified maintainer yet), sent (in a PayPal batch that has not settled) and paid, plus the claim status, PayPal's status for its latest payout, and how long any hold has left.",
    usage: "Use it to show who has been paid and who is still waiting. Amounts are PayPal-confirmed money in the space's currency.",
    configuration: "repo: maintainers.repo. held, sent, paid: allocations.held_amount, allocations.sent_amount, allocations.paid_amount with sum. claim: maintainers.status. paypal: maintainers.paypal_status. expires: maintainers.hold_expires_at.",
  },
};

export const UPSTREAM_WIDGET_IDS = ["declared-vs-used", "money-trail"] as const;

export const insightsWidgets = (cfg: AgWidgetsConfig<AgCoreDefaultRegistry>): AgWidgetsConfig<UpstreamRegistry> =>
  createWidgets<UpstreamRegistry>({
    additionalTypes: [declaredVsUsed, moneyTrail] as never,
    menu: [...cfg.menu, { label: "Upstream", widgetIds: [...UPSTREAM_WIDGET_IDS] }] as never,
  });
