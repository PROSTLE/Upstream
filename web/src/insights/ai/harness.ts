// Insights' AG Studio agents, all on Muse Spark through this server's proxy.
// Studio's five agents (lead, planning, data, page, widget) run as AG ships them, except that our lead
// may also hand work to the ledger auditor, and is told to whenever it builds a widget that shows money.
// The auditor is ours: it checks numbers on the board against Upstream's books. Every tool it has only
// reads; no agent here can change data or move money.
import { createAiHarness, directLlmRunner, type AgAiAgentContext, type AgAiPromptStarter, type AgAiTool, type AgStudioApi } from "ag-studio";
import { api as http } from "../../api.ts";
import { openaiAdapter } from "./adapter.ts";

export const AUDITOR_ID = "ledger-auditor";
const LEAD_DELEGATES = ["planning", "data", "page", "widget", AUDITOR_ID];

const AUDITOR_INSTRUCTIONS = [
  "You check numbers on this board against Upstream's books. Never estimate.",
  "Find the widget you were asked about with view_page and view_widget, and read its numbers with execute_query.",
  "Call upstream_ledger_totals for the same period and currency, and call upstream_safety_checks.",
  "Compare in minor units (cents): the ledger returns in_minor, paid_minor, fees_minor, held_minor and refunded_minor.",
  "Reply with 'Matches the ledger' or 'Mismatch', then give both numbers for each value you checked, and name any failing safety check.",
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
      for (const k of ["from", "to", "currency"] as const) if (args[k]) q.set(k, String(args[k]));
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
              `${lead.instructions?.(ctx, params as never) ?? ""}\n\nAfter you build or change a widget that shows money, ask ${AUDITOR_ID} to verify it, and pass on its answer.`,
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
            tools: () => [tools.studio.viewPage(), tools.studio.viewWidget(), tools.studio.executeQuery(), ...ownTools],
            maxTurns: 12,
          }),
        ],
        primary: "lead",
        promptStarters: PROMPT_STARTERS,
        models: [{ id: model, label: "Muse Spark" }],
      };
    });
}
