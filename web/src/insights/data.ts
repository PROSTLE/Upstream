// AG Studio's data definition for /insights, built from GET /api/studio/data.
// Every table and field carries a plain-English description: Studio shows them in the field panel,
// and its agents read them to understand the data. Nothing here invents a number; derived fields
// only re-sort the real rows (money in, paid out, fees, held) so the board can sum them directly.
import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition } from "ag-studio";
import type { UpstreamRegistry } from "./widgets/types.ts";

export interface StudioPayload {
  generatedAt: string;
  currency: string;
  sources: {
    sessions: { id: string; project: string; started_at: string; ended_at: string | null; status: string; evidence_count: number; packages_used: number }[];
    shares: { session_id: string; ecosystem: string; package: string; method: "llm" | "imports" | "manifest"; share: number; in_manifest: boolean; has_evidence: boolean; comparable: boolean }[];
    allocations: { id: string; settlement_id: string; repo: string | null; ecosystem: string; package: string; amount: number; currency: string; status: string; created_at: string; expires_at: string | null }[];
    payouts: { sender_item_id: string; settlement_id: string; repo: string | null; amount: number; fee: number | null; currency: string; transaction_status: string; status_changed_at: string | null }[];
    maintainers: { repo: string; method: string | null; status: string; verified_at: string | null }[];
    ledger: { id: number; occurred_at: string; kind: string; amount: number; currency: string; ref_type: string | null }[];
    moneyEvents: { id: number; at: string; type: string; from_node: string | null; to_node: string | null; amount: number; currency: string; kind: string | null; repo: string | null; status_to: string | null }[];
  };
}

export const CALENDAR_ID = "calendar";

type Extra = { hide?: boolean; accessor?: (row: any) => unknown };
type Spec = [id: string, name: string, format: AgFormat<UpstreamRegistry>, description: string, extra?: Extra];
/** Field definitions; money fields format in the space's own currency. */
const fieldsFor = (currency: string) => {
  const money = { format: new Intl.NumberFormat("en-US", { style: "currency", currency }) };
  return (specs: Spec[]) =>
    specs.map(
      ([id, name, format, description, extra]) =>
        ({ id, name, format, description, ...(format === "currencyFormat" && { formatOptions: money }), ...extra }) as AgFieldDefinition<UpstreamRegistry>,
    );
};
const hidden = { hide: true } as const;

const METHOD_LABEL: Record<string, string> = {
  llm: "Upstream (Muse Spark)",
  imports: "Counting imports",
  manifest: "Dependency list",
};
const LEDGER_LABEL: Record<string, string> = {
  FUNDING_GROSS: "Money in",
  FUNDING_FEE: "PayPal fee on money in",
  PAYOUT_SENT: "Paid to a maintainer",
  PAYOUT_FEE: "PayPal payout fee",
  PAYOUT_RETURNED: "Payout returned",
};
const ALLOCATION_LABEL: Record<string, string> = {
  planned: "Planned (draft)",
  reserved: "Held for an unclaimed repo",
  in_batch: "Sent, waiting on PayPal",
  paid: "Paid",
  released: "Released back to the pool",
};

const many = (id: string, source: string, target: string): AgRelationDefinition => ({ id, source, target, type: "many-to-one" });
const onCalendar = (table: string, field: string): AgRelationDefinition =>
  ({ id: `${table}-${field}-calendar`, source: `${table}.${field}`, target: { calendarId: CALENDAR_ID }, truncate: "day" }) as AgRelationDefinition;

/** Per maintainer repo: the latest real PayPal status of its payouts, and when its earliest hold expires. */
function maintainerExtras(p: StudioPayload) {
  const paypal = new Map<string, { at: string; status: string }>();
  for (const x of p.sources.payouts) {
    if (!x.repo) continue;
    const at = x.status_changed_at ?? "";
    const prev = paypal.get(x.repo);
    if (!prev || at > prev.at) paypal.set(x.repo, { at, status: x.transaction_status });
  }
  const expires = new Map<string, string>();
  for (const a of p.sources.allocations) {
    if (!a.repo || a.status !== "reserved" || !a.expires_at) continue;
    const prev = expires.get(a.repo);
    if (!prev || a.expires_at < prev) expires.set(a.repo, a.expires_at);
  }
  return { paypal, expires };
}

export function buildStudioData(p: StudioPayload): AgDataSourcesDefinition<UpstreamRegistry> {
  const s = p.sources;
  const cur = p.currency;
  const fields = fieldsFor(cur);
  const { paypal, expires } = maintainerExtras(p);
  const dates = [
    ...s.ledger.map((r) => r.occurred_at),
    ...s.sessions.map((r) => r.started_at),
    ...s.allocations.map((r) => r.created_at),
    ...s.moneyEvents.map((r) => r.at),
    ...s.payouts.map((r) => r.status_changed_at ?? ""),
  ]
    .filter(Boolean)
    .map((d) => d.slice(0, 10))
    .sort();
  const today = p.generatedAt.slice(0, 10);

  return {
    description:
      "Upstream pays open-source maintainers through PayPal, in proportion to evidence of what a person's AI coding agent actually used. " +
      `All money is in ${cur} and comes from the PayPal sandbox: no real money moves. ` +
      "A session is one coding-agent session. Shares are the fraction of that session's budget each package would get, by three methods: " +
      "Upstream (Muse Spark, which must cite evidence), counting imports, and an equal split across the dependency list. " +
      "Allocations earmark money for a repo; payouts are what PayPal actually sent. Money held for a repo whose maintainer has not proven ownership stays in the pool until it expires.",
    sources: [
      {
        id: "sessions",
        name: "Coding sessions",
        description: "One row per coding-agent session recorded by Upstream's hook.",
        primaryKeyField: "id",
        data: s.sessions,
        fields: fields([
          ["id", "Session ID", "textFormat", "Upstream's id for the session.", hidden],
          ["project", "Project", "textFormat", "The project folder the agent worked in."],
          ["started_at", "Started", "dateTimeFormat", "When the session's first event arrived."],
          ["ended_at", "Ended", "dateTimeFormat", "When the session ended, if it has."],
          ["status", "Status", "textFormat", "open, closed, or attributed (the AI review has run)."],
          ["evidence_count", "Evidence records", "integerFormat", "How many pieces of evidence the hook recorded: installs, imports, source reads, docs lookups."],
          ["packages_used", "Packages credited", "integerFormat", "How many packages Upstream's AI review gave a share above zero."],
        ]),
      },
      {
        id: "shares",
        name: "Package shares",
        description:
          "One row per session, package and method: the fraction of that session's budget the method gives the package (0 to 1). " +
          "A package declared in the project file but never used still has a row, with an Upstream share of 0.",
        data: s.shares,
        fields: fields([
          ["session_id", "Session ID", "textFormat", "The session this share belongs to.", hidden],
          ["ecosystem", "Ecosystem", "textFormat", "Package registry: npm or pypi."],
          ["package", "Package", "textFormat", "The open-source package's name."],
          ["method", "Method code", "textFormat", "llm, imports or manifest.", hidden],
          ["method_label", "Method", "textFormat", "How the share was decided: Upstream (Muse Spark), Counting imports, or Dependency list (an equal split).", { accessor: (r: any) => METHOD_LABEL[r.method] ?? r.method }],
          ["share", "Share", "percentageFormat", "Fraction of the session's budget this method gives the package."],
          ["llm_share", "Upstream share", "percentageFormat", "The share Upstream's AI review gives the package; 0 for other methods' rows.", { accessor: (r: any) => (r.method === "llm" ? r.share : 0) }],
          ["manifest_share", "Dependency-list share", "percentageFormat", "The share an equal split across the project file gives the package; 0 for other methods' rows.", { accessor: (r: any) => (r.method === "manifest" ? r.share : 0) }],
          ["imports_share", "Import-count share", "percentageFormat", "The share counting imports gives the package; 0 for other methods' rows.", { accessor: (r: any) => (r.method === "imports" ? r.share : 0) }],
          ["in_manifest", "Declared", "booleanFormat", "True when the package is listed in the project's dependency file."],
          ["has_evidence", "Has evidence", "booleanFormat", "True when the hook recorded the agent installing, importing or reading this package."],
          ["comparable", "Comparable", "booleanFormat", "True when the session has both an Upstream review and a dependency list, so the two shares can be compared like for like."],
        ]),
      },
      {
        id: "allocations",
        name: "Allocations",
        description: "Money earmarked for a maintainer repo by a payout run. Held means the repo has no verified maintainer yet.",
        primaryKeyField: "id",
        data: s.allocations,
        fields: fields([
          ["id", "Allocation ID", "textFormat", "Upstream's id for the earmark.", hidden],
          ["settlement_id", "Payout run", "textFormat", "The payout run that made this earmark."],
          ["repo", "Repo", "textFormat", "The maintainer repo the money is for (owner/name)."],
          ["ecosystem", "Ecosystem", "textFormat", "Package registry: npm or pypi."],
          ["package", "Package", "textFormat", "The package whose share produced this money."],
          ["amount", "Amount", "currencyFormat", `Earmarked amount in ${cur}.`],
          ["currency", "Currency", "textFormat", "ISO currency code."],
          ["status", "Status code", "textFormat", "planned, reserved, in_batch, paid or released.", hidden],
          ["status_label", "Status", "textFormat", "Where the money is: held, sent and waiting on PayPal, paid, or released.", { accessor: (r: any) => ALLOCATION_LABEL[r.status] ?? r.status }],
          ["held_amount", "Held", "currencyFormat", `Amount still held because the repo has no verified maintainer, in ${cur}.`, { accessor: (r: any) => (r.status === "reserved" ? r.amount : 0) }],
          ["sent_amount", "Sent", "currencyFormat", `Amount in a PayPal batch that has not settled yet, in ${cur}.`, { accessor: (r: any) => (r.status === "in_batch" ? r.amount : 0) }],
          ["paid_amount", "Paid", "currencyFormat", `Amount PayPal confirmed as paid, in ${cur}.`, { accessor: (r: any) => (r.status === "paid" ? r.amount : 0) }],
          ["created_at", "Earmarked", "dateTimeFormat", "When the earmark was made."],
          ["expires_at", "Hold expires", "dateTimeFormat", "When held money goes back to the pool if nobody claims the repo."],
        ]),
      },
      {
        id: "payouts",
        name: "Payouts",
        description: "One row per PayPal payout item. Status is PayPal's own transaction status.",
        primaryKeyField: "sender_item_id",
        data: s.payouts,
        fields: fields([
          ["sender_item_id", "Item ID", "textFormat", "Upstream's id for the payout item.", hidden],
          ["settlement_id", "Payout run", "textFormat", "The payout run this item was sent in."],
          ["repo", "Repo", "textFormat", "The maintainer repo that was paid (owner/name)."],
          ["amount", "Amount", "currencyFormat", `Amount sent, in ${cur}.`],
          ["fee", "PayPal fee", "currencyFormat", `PayPal's fee for this item, as PayPal reported it, in ${cur}.`],
          ["currency", "Currency", "textFormat", "ISO currency code."],
          ["transaction_status", "PayPal status", "textFormat", "PayPal's transaction status: SUCCESS, PENDING, UNCLAIMED, RETURNED and so on."],
          ["status_changed_at", "Status changed", "dateTimeFormat", "When PayPal's status last changed."],
        ]),
      },
      {
        id: "maintainers",
        name: "Maintainers",
        description: "One row per repo this space's money touched, with whether its maintainer has proven they run it.",
        primaryKeyField: "repo",
        data: s.maintainers,
        fields: fields([
          ["repo", "Repo", "textFormat", "The maintainer repo (owner/name)."],
          ["method", "Proof", "textFormat", "How ownership was proven: github_admin or funding_yml_token. Empty when unclaimed."],
          ["status", "Claim", "textFormat", "verified, pending, receiver_unclaimed, revoked, or unclaimed when nobody has claimed it."],
          ["verified_at", "Verified", "dateTimeFormat", "When ownership was verified."],
          ["paypal_status", "Latest PayPal status", "textFormat", "PayPal's status for this repo's most recent payout, if any.", { accessor: (r: any) => paypal.get(r.repo)?.status ?? null }],
          ["hold_expires_at", "Hold expires", "dateTimeFormat", "When this repo's earliest held money goes back to the pool.", { accessor: (r: any) => expires.get(r.repo) ?? null }],
        ]),
      },
      {
        id: "ledger",
        name: "Ledger",
        description: "Every PayPal-confirmed money movement, signed: positive is money in, negative is money out.",
        primaryKeyField: "id",
        data: s.ledger,
        fields: fields([
          ["id", "Entry", "integerFormat", "Ledger entry number.", hidden],
          ["occurred_at", "When", "dateTimeFormat", "When PayPal says the movement happened."],
          ["kind", "Kind code", "textFormat", "FUNDING_GROSS, FUNDING_FEE, PAYOUT_SENT, PAYOUT_FEE or PAYOUT_RETURNED.", hidden],
          ["kind_label", "Entry", "textFormat", "What the movement was, in plain words.", { accessor: (r: any) => (r.kind === "FUNDING_GROSS" && r.amount < 0 ? "Refund" : (LEDGER_LABEL[r.kind] ?? r.kind)) }],
          ["amount", "Amount", "currencyFormat", `Signed amount in ${cur}.`],
          ["money_in", "Funds in", "currencyFormat", `Money PayPal confirmed coming in (subscription payments and top-ups), in ${cur}.`, { accessor: (r: any) => (r.kind === "FUNDING_GROSS" && r.amount > 0 ? r.amount : 0) }],
          ["paid_out", "Paid out", "currencyFormat", `Money sent to maintainers, net of returns, in ${cur}.`, { accessor: (r: any) => (r.kind === "PAYOUT_SENT" || r.kind === "PAYOUT_RETURNED" ? -r.amount : 0) }],
          ["fees", "Fees", "currencyFormat", `PayPal's fees on money in and on payouts, in ${cur}.`, { accessor: (r: any) => (r.kind === "FUNDING_FEE" || r.kind === "PAYOUT_FEE" ? -r.amount : 0) }],
          ["currency", "Currency", "textFormat", "ISO currency code."],
          ["ref_type", "Source", "textFormat", "What the entry refers to: subscription, top-up or payout."],
        ]),
      },
      {
        id: "moneyEvents",
        name: "Money events",
        description: "The timeline the money diagram replays: each PayPal-confirmed step from one place to another.",
        primaryKeyField: "id",
        data: s.moneyEvents,
        fields: fields([
          ["id", "Event", "integerFormat", "Event number.", hidden],
          ["at", "When", "dateTimeFormat", "When it happened."],
          ["type", "Type", "textFormat", "ledger, payout_status, batch or earmark."],
          ["from_node", "From", "textFormat", "Where the money moved from: in, pool, paypal, fees, held, paid or waiting."],
          ["to_node", "To", "textFormat", "Where the money moved to."],
          ["amount", "Amount", "currencyFormat", `Amount in ${cur}.`],
          ["currency", "Currency", "textFormat", "ISO currency code."],
          ["kind", "Kind", "textFormat", "The ledger kind behind the event, when there is one."],
          ["repo", "Repo", "textFormat", "The maintainer repo involved, when there is one."],
          ["status_to", "New status", "textFormat", "PayPal's new status for a payout event."],
        ]),
      },
    ],
    relationships: [
      many("shares-sessions", "shares.session_id", "sessions.id"),
      many("allocations-maintainers", "allocations.repo", "maintainers.repo"),
      many("payouts-maintainers", "payouts.repo", "maintainers.repo"),
      onCalendar("ledger", "occurred_at"),
      onCalendar("sessions", "started_at"),
      onCalendar("allocations", "created_at"),
      onCalendar("payouts", "status_changed_at"),
      onCalendar("moneyEvents", "at"),
    ],
    calendars: [
      {
        id: CALENDAR_ID,
        label: "Calendar",
        range: { from: { type: "date", value: dates[0] ?? today }, to: { type: "date", value: dates.at(-1) ?? today } },
        fragments: ["year", "quarter", "month", "week", "day"],
      },
    ],
  };
}
