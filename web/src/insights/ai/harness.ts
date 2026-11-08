// Insights' AG Studio agents, all on Muse Spark through this server's proxy.
// Studio's five agents (lead, planning, data, page, widget) run as AG ships them, except that our lead
// may also hand work to the ledger auditor, and is told to whenever it builds a widget that shows money.
// The auditor is ours: it checks numbers on the board against Upstream's books, reading a widget's numbers
// through read_widget_numbers (code builds that query, not the model). Every tool it has only reads; no
// agent here can change data or move money.
import { createAiHarness, directLlmRunner, type AgAiAgentContext, type AgAiPromptStarter, type AgAiTool, type AgStudioApi } from "ag-studio";
import { api as http } from "../../api.ts";
import { openaiAdapter } from "./adapter.ts";

export const AUDITOR_ID = "ledger-auditor";
const LEAD_DELEGATES = ["planning", "data", "page", "widget", AUDITOR_ID];

const AUDITOR_INSTRUCTIONS = [
  "You check numbers on this board against Upstream's books. Never estimate, and never work a widget's numbers out yourself.",
  "Find the widget you were asked about with view_page, and read the numbers it shows with read_widget_numbers.",
  "Take the period from the filters read_widget_numbers reports: a relative 'this month' runs from the 1st of this month to today.",
  "Call upstream_ledger_totals for the same period and currency, and call upstream_safety_checks.",
  "Compare in minor units (cents): read_widget_numbers gives value_minor; the ledger gives in_minor, paid_minor, fees_minor, held_minor and refunded_minor.",
  "Reply with 'Matches the ledger' or 'Mismatch', then give both numbers for each value you checked, and name any failing safety check or any filter that could not be applied.",
  "You cannot change data or move money.",
].join("\n");

export const PROMPT_STARTERS: AgAiPromptStarter[] = [
  {
    label: "Where did this month's money go?",
    prompt:
      "Add a widget showing this month's money: funds in, paid out, held for unclaimed maintainers, and fees. Then have the ledger auditor check the totals.",
  },
  {
    label: "Who is still waiting to be paid?",
    prompt: "Show maintainers whose money is held because they haven't claimed it, and how long until each hold expires.",
  },
  {
    label: "What did my agent never use?",
    prompt:
      "Which libraries were declared in project files but never used by the agent, and how much would a dependency-list split have paid them?",
  },
];

type BoardFilter = { field: { id: string }; model?: Record<string, unknown> };
type Measure = { id: string; aggregation: string };
const tableOf = (fieldId: string) => fieldId.split(".")[0]!;
const MONEY = /(amount|money_in|paid_out|fees?)$/;

/** Every measure a widget's data mapping uses, whatever the widget type. */
function measuresOf(mapping: unknown, acc: Measure[] = []): Measure[] {
  if (Array.isArray(mapping)) mapping.forEach((m) => measuresOf(m, acc));
  else if (mapping && typeof mapping === "object") {
    const o = mapping as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.aggregation === "string" && o.id.includes(".")) {
      if (!acc.some((m) => m.id === o.id && m.aggregation === o.aggregation)) acc.push({ id: o.id, aggregation: o.aggregation });
    } else Object.values(o).forEach((v) => measuresOf(v, acc));
  }
  return acc;
}

/**
 * What a widget shows, read by code rather than by the model: its measures, under its own and its page's
 * filters, each table totalled over its own rows by Studio's query engine. An auditor that rebuilt the
 * query itself once joined two tables and reported doubled totals for a widget that was right.
 */
function readWidgetNumbers(api: AgStudioApi, executeQuery: AgAiTool): AgAiTool {
  return api.defineAiTool({
    name: "read_widget_numbers",
    description:
      "The totals a widget on the board shows, and the filters they are under. Money values come in dollars (value) and cents (value_minor). Read-only.",
    params: (s) => s.object({ widgetId: s.string({ description: "The widget's id, from view_page." }) }),
    execute: async (args, ctx) => {
      const widgetId = String(args.widgetId);
      const pages = (api.getState().pages ?? []) as unknown as {
        widgets?: Record<string, { dataMapping?: unknown; format?: { title?: { text?: string } } }>;
        filter?: { page?: BoardFilter[]; widget?: Record<string, BoardFilter[]> };
      }[];
      const page = pages.find((p) => p.widgets?.[widgetId]);
      if (!page) return ctx.error(`There is no widget ${widgetId} on the board.`);
      const widget = page.widgets![widgetId]!;
      const measures = measuresOf(widget.dataMapping);
      if (measures.length === 0) return ctx.error(`Widget ${widgetId} shows no totals.`);
      const filters = [...(page.filter?.page ?? []), ...(page.filter?.widget?.[widgetId] ?? [])];
      const applied = new Set<BoardFilter>();
      const values: { field: string; aggregation: string; value: number | null; value_minor?: number | null }[] = [];

      for (const table of [...new Set(measures.map((m) => tableOf(m.id)))]) {
        const own = measures.filter((m) => tableOf(m.id) === table);
        const mine = filters.filter((f) => tableOf(f.field.id) === table || f.field.id.startsWith("calendar::"));
        mine.forEach((f) => applied.add(f));
        const conds = mine.map((f) => ({ field: f.field, ...f.model }));
        const query: Record<string, unknown> = {
          variant: "aggregation",
          kind: "apiQuery",
          measures: own.map((m, i) => ({ field: { id: m.id, aggregation: m.aggregation }, as: `m${i}` })),
        };
        if (conds.length === 1) query.filter = conds[0];
        else if (conds.length > 1) query.filter = { combinator: "and", conditions: conds };
        const r = (await executeQuery.execute!({ toolCallId: `read-${widgetId}-${table}`, name: "execute_query", args: { query } }, ctx)) as unknown as {
          success: boolean;
          data?: { result?: Record<string, number | null>[] };
          response?: string;
        };
        if (!r.success) return ctx.error(`Could not read ${table} for ${widgetId}: ${r.response ?? "the query failed"}`);
        const row = r.data?.result?.[0] ?? {};
        own.forEach((m, i) => {
          const v = row[`m${i}`] ?? null;
          values.push({ field: m.id, aggregation: m.aggregation, value: v, ...(MONEY.test(m.id) ? { value_minor: v === null ? null : Math.round(v * 100) } : {}) });
        });
      }
      const describe = (f: BoardFilter) => ({ field: f.field.id, ...f.model });
      const out = {
        widgetId,
        title: widget.format?.title?.text ?? null,
        values,
        filters_applied: filters.filter((f) => applied.has(f)).map(describe),
        filters_not_applied: filters.filter((f) => !applied.has(f)).map(describe),
      };
      return ctx.success(JSON.stringify(out), out);
    },
  });
}

/** The auditor's two tools, both plain reads of this server's own endpoints. */
function auditorTools(api: AgStudioApi): AgAiTool[] {
  const totals = api.defineAiTool({
    name: "upstream_ledger_totals",
    description:
      "Upstream's own books for a period, from the PayPal-confirmed ledger: money in, refunds, paid to maintainers, PayPal fees, held for unclaimed maintainers and the balance, all in minor units (cents). Read-only.",
    params: (s) =>
      s.object({
        from: s.string({ description: "First day to include, YYYY-MM-DD. Omit for all time." }).optional(),
        to: s.string({ description: "Last day to include, YYYY-MM-DD. Omit for up to today." }).optional(),
        currency: s.string({ description: "ISO currency code, for example USD. Omit for this space's currency." }).optional(),
      }),
    execute: async (args, ctx) => {
      const q = new URLSearchParams();
      // Muse Spark sometimes fills an optional argument with the string "null"; only well-formed values count.
      const valid = { from: /^\d{4}-\d{2}-\d{2}$/, to: /^\d{4}-\d{2}-\d{2}$/, currency: /^[A-Z]{3}$/ };
      for (const k of ["from", "to", "currency"] as const) {
        const v = typeof args[k] === "string" ? args[k].trim().toUpperCase() : "";
        if (valid[k].test(v)) q.set(k, v);
      }
      try {
        const t = await http<Record<string, unknown>>(`/api/studio/totals?${q}`);
        const { checks: _checks, ...money } = t;
        return ctx.success(JSON.stringify(money), money);
      } catch (e) {
        return ctx.error((e as Error).message);
      }
    },
  });
  const checks = api.defineAiTool({
    name: "upstream_safety_checks",
    description: "The safety checks Upstream re-runs on its books: each check's name and whether it passes, fails, or has nothing to check yet. Read-only.",
    params: (s) => s.object({}),
    execute: async (_args, ctx) => {
      try {
        const a = await http<{ checks: { label: string; status: string; detail: string }[] }>("/api/audit");
        const list = a.checks.map((c) => ({ name: c.label, status: c.status, detail: c.detail }));
        return ctx.success(JSON.stringify(list), list);
      } catch (e) {
        return ctx.error((e as Error).message);
      }
    },
  });
  return [totals, checks];
}

export function buildInsightsAi(model: string) {
  // The lead posts to /api/studio/llm, its helpers to /api/studio/llm/delegate: the server counts a visitor's
  // question once, when the lead gets it, not again each time a helper is handed part of it.
  const adapter = openaiAdapter({ endpoint: "/api/studio/llm", model });
  const delegateAdapter = openaiAdapter({ endpoint: "/api/studio/llm/delegate", model });
  return ({ api }: { api: AgStudioApi }) =>
    createAiHarness(api, ({ builtIn, tools }) => {
      const lead = builtIn.lead;
      const ownTools = auditorTools(api);
      return {
        agents: [
          // AG's lead, widened to delegate to the auditor too.
          directLlmRunner({
            ...lead,
            adapter,
            instructions: (ctx: AgAiAgentContext, params: unknown) =>
              `${lead.instructions?.(ctx, params as never) ?? ""}\n\nAfter you build or change a widget that shows money, ask ${AUDITOR_ID} to verify it, and pass on its answer. If it reports a mismatch, tell the person what it found; never change the widget just to make the numbers agree.`,
            tools: (ctx: AgAiAgentContext, params: unknown) => [
              ...(lead.tools?.(ctx, params as never) ?? []).filter((t) => t.name !== "delegate_to"),
              tools.delegateTo(LEAD_DELEGATES),
            ],
          } as never),
          ...(["planning", "data", "page", "widget"] as const).map((id) => directLlmRunner({ ...builtIn[id], adapter: delegateAdapter } as never)),
          directLlmRunner({
            id: AUDITOR_ID,
            name: "Ledger auditor",
            adapter: delegateAdapter,
            description:
              "Checks that money shown on the board matches Upstream's books (the PayPal-confirmed ledger) and its safety checks. Hand it any widget that shows money, with the period it covers.",
            schema: (s) => s.undefined(),
            instructions: () => AUDITOR_INSTRUCTIONS,
            tools: () => [tools.studio.viewPage(), tools.studio.viewWidget(), readWidgetNumbers(api, tools.studio.executeQuery()), ...ownTools],
            maxTurns: 12,
          }),
        ],
        primary: "lead",
        promptStarters: PROMPT_STARTERS,
        models: [{ id: model, label: "Muse Spark" }],
      };
    });
}
