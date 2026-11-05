import { createContext, useContext, type ReactNode } from "react";
import { useApi } from "./api.ts";
import { moneyStr, plural } from "./format.ts";

// One poll of /api/overview feeds the sidebar's progress, the top bar and the Overview page.
type Ctx = { data: any | null; error: string | null; reload: () => Promise<void> };
const OverviewCtx = createContext<Ctx>({ data: null, error: null, reload: async () => {} });
export const useOverview = () => useContext(OverviewCtx);

export function OverviewProvider({ children }: { children: ReactNode }) {
  const { data, error, reload } = useApi<any>("/api/overview", [], { poll: 15000 });
  return <OverviewCtx.Provider value={{ data, error, reload }}>{children}</OverviewCtx.Provider>;
}

export interface SetupStep {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
  /** What to do next, and where. */
  cta?: { label: string; to?: string; href?: string };
  /** A shell command when the fix happens outside the browser. */
  command?: string;
}

/** The setup journey in pipeline order. The first step that isn't done is the "next step". */
export function setupSteps(d: any): SetupStep[] {
  const f = d.features;
  const cur = d.pool.currency;
  // Server setup is the operator's job, so everyone else only sees the steps that are theirs to do.
  const serverSteps = new Set(["paypal", "plan", "llm"]);
  return ([
    {
      id: "paypal", ok: f.paypal, label: "Connect PayPal",
      detail: f.paypal ? `Connected to PayPal ${d.environment === "sandbox" ? "test mode" : d.environment}` : "Add your PayPal app keys to the server's settings (.env).",
      command: "npm run doctor",
    },
    {
      id: "plan", ok: Boolean(d.plan_id), label: "Create your budget plan",
      detail: d.plan_id ? `Plan ${d.plan_id}` : "Creates the catalog product, the billing plan and (on https) the webhook. Safe to re-run.",
      command: "npm run setup:paypal",
    },
    {
      id: "fund", ok: d.subscription?.status === "ACTIVE" || d.pool.fundingGross > 0, label: "Add funds",
      detail: d.subscription?.status === "ACTIVE" ? "Your monthly budget is active" : d.pool.fundingGross > 0 ? "PayPal has confirmed your funds" : `Approve ${moneyStr(d.tithe.amount, cur)} per ${d.tithe.interval.toLowerCase()} once in PayPal, or add money once. Cancel any time.`,
      cta: { label: "Add funds", to: "/funding" },
    },
    {
      id: "connect", ok: d.counts.sessions > 0, label: "Connect your coding agent",
      detail: d.counts.sessions ? `${plural(d.counts.sessions, "session")} recorded` : "Run one command in your project, then code as usual. We record which packages the agent really uses.",
      cta: { label: "Connect your agent", to: "/connect" },
    },
    {
      id: "llm", ok: f.llm, label: "Turn on the AI review",
      detail: f.llm ? `Model ${d.model}` : "Set MODEL_API_KEY on the server. Without it, only the import-count baseline runs.",
      command: "npm run doctor",
    },
    {
      id: "attribute", ok: d.counts.attributed > 0, label: "Review a session with AI",
      detail: d.counts.attributed ? `${plural(d.counts.attributed, "session")} reviewed` : "Open a session and let Muse Spark work out which packages mattered.",
      cta: { label: "Open sessions", to: "/sessions" },
    },
    {
      id: "claim", ok: d.counts.verified_claims > 0, label: "Get a maintainer verified",
      detail: d.counts.verified_claims ? `${plural(d.counts.verified_claims, "verified maintainer")}` : "Maintainers prove they control the repo, then add a PayPal email. Share the claim page.",
      cta: { label: "Open claim page", href: "/claim" },
    },
    {
      id: "pay", ok: d.counts.settlements > 0, label: "Pay maintainers",
      detail: d.counts.settlements ? `${plural(d.counts.settlements, "payout run")}` : `${d.brand} proposes who gets what. You check it and approve, then PayPal sends the money.`,
      cta: { label: "Pay maintainers", to: "/settlements" },
    },
  ] as SetupStep[]).filter((s) => d.viewer?.operator || !serverSteps.has(s.id));
}
