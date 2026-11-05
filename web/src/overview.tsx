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
  return [
    {
      id: "paypal", ok: f.paypal, label: "Add PayPal sandbox credentials",
      detail: "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from developer.paypal.com → Apps & Credentials → Sandbox, in the server's .env.",
      command: "npm run doctor",
    },
    {
      id: "plan", ok: Boolean(d.plan_id), label: "Create the funding plan in PayPal",
      detail: d.plan_id ? `Plan ${d.plan_id}` : "Creates the catalog product, the billing plan and (on https) the webhook. Safe to re-run.",
      command: "npm run setup:paypal",
    },
    {
      id: "fund", ok: d.subscription?.status === "ACTIVE" || d.pool.fundingGross > 0, label: "Fund the pool",
      detail: d.subscription?.status === "ACTIVE" ? `Subscription ${d.subscription.id} is ACTIVE` : d.pool.fundingGross > 0 ? "The pool has PayPal-confirmed funds" : `Approve the ${moneyStr(d.tithe.amount, cur)} per ${d.tithe.interval.toLowerCase()} agent tithe once in PayPal, or add funds once. Cancel any time.`,
      cta: { label: "Go to Funding", to: "/funding" },
    },
    {
      id: "connect", ok: d.counts.sessions > 0, label: "Connect Claude Code",
      detail: d.counts.sessions ? `${plural(d.counts.sessions, "session")}, ${d.counts.evidence} evidence records` : "Install the hook in a project, then code as usual. Every tool call becomes evidence.",
      cta: { label: "Install the hook", to: "/connect" },
    },
    {
      id: "llm", ok: f.llm, label: "Turn on Muse Spark attribution",
      detail: f.llm ? `Model ${d.model}` : "Set MODEL_API_KEY on the server. Without it, only the import-count baseline runs.",
      command: "npm run doctor",
    },
    {
      id: "attribute", ok: d.counts.attributed > 0, label: "Attribute a session",
      detail: d.counts.attributed ? `${plural(d.counts.attributed, "session")} attributed` : "Open a session, label it if you want a blind eval, then attribute it with Muse Spark.",
      cta: { label: "Open sessions", to: "/sessions" },
    },
    {
      id: "claim", ok: d.counts.verified_claims > 0, label: "Get a maintainer verified",
      detail: d.counts.verified_claims ? `${plural(d.counts.verified_claims, "verified maintainer")}` : "Maintainers prove they control the repo, then add a PayPal email. Share the claim page.",
      cta: { label: "Open claim page", href: "/claim" },
    },
    {
      id: "pay", ok: d.counts.settlements > 0, label: "Plan and send a payout",
      detail: d.counts.settlements ? `${plural(d.counts.settlements, "payout run")}` : `${d.brand} proposes one PayPal Payouts batch; you review the policy checks and approve it.`,
      cta: { label: "Go to Payouts", to: "/settlements" },
    },
  ];
}
