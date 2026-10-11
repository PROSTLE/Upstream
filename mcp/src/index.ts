#!/usr/bin/env node
// Upstream MCP server: gives a coding agent a guarded view of PayPal Payouts.
// The agent can inspect evidence, propose a settlement and send a batch a human already approved.
// It can never choose receivers or amounts: those come from validated attribution and verified claims.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.UPSTREAM_URL?.replace(/\/+$/, "");
const ADMIN = process.env.UPSTREAM_ADMIN_TOKEN;

async function call(method: "GET" | "POST", path: string, admin = false): Promise<unknown> {
  if (!BASE) throw new Error("UPSTREAM_URL is not set for the Upstream MCP server.");
  if (admin && !ADMIN) throw new Error("UPSTREAM_ADMIN_TOKEN is not set, so payout actions are disabled for this agent.");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(admin ? { "x-admin-token": ADMIN! } : {}) },
    body: method === "POST" ? "{}" : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

const server = new McpServer({ name: "upstream", version: "0.1.0" });

server.registerTool(
  "upstream_session_evidence",
  {
    title: "Show open-source usage evidence",
    description:
      "Lists the open-source packages this coding session relied on, with the evidence Upstream recorded (installs, imports, API usage, docs read) and which ones were only present in the manifest.",
    inputSchema: { session_id: z.string().optional().describe("Defaults to the most recently active session.") },
  },
  async ({ session_id }) => {
    try {
      let id = session_id;
      if (!id) {
        const list = (await call("GET", "/api/sessions")) as { id: string }[];
        id = list[0]?.id;
        if (!id) return text({ message: "No sessions recorded yet. Is the Upstream hook installed?" });
      }
      const s = (await call("GET", `/api/sessions/${encodeURIComponent(id)}`)) as any;
      return text({
        session_id: id,
        project: s.session.project,
        status: s.session.status,
        candidates: s.candidates.candidates.map((c: any) => ({ package: `${c.ecosystem}:${c.name}`, status: c.status, evidence: c.counts, repo: c.repo })),
        unattributed_evidence: s.candidates.unattributed.length,
        active_attribution: s.runs.find((r: any) => r.is_active)?.validated.weights ?? null,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upstream_attribute_session",
  {
    title: "Attribute a session",
    description: "Runs Upstream's LLM attribution (with deterministic validation and the import-count baseline) for a session.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    try {
      return text(await call("POST", `/api/sessions/${encodeURIComponent(session_id)}/attribute`, true));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upstream_plan_payout",
  {
    title: "Plan a maintainer payout",
    description:
      "Drafts a PayPal Payouts settlement from attributed sessions and verified maintainer claims, and returns the policy checks. It does not send money: a human approves drafts in the Upstream dashboard.",
    inputSchema: {},
  },
  async () => {
    try {
      const s = (await call("POST", "/api/settlements/plan", true)) as any;
      return text({
        settlement_id: s.id,
        status: s.status,
        items: s.items.map((i: any) => ({ repo: i.repo, amount: `${i.amount} ${i.currency}` })),
        reserved_for_unclaimed_repos: s.reserved_minor,
        policy_checks: s.policy.checks,
        next_step: "Ask the user to review and approve this draft in the Upstream dashboard (Settlements page).",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upstream_send_approved_payout",
  {
    title: "Send an approved PayPal payout batch",
    description:
      "Sends a settlement a human has already approved as one PayPal Payouts batch. Safe to retry: the batch uses a fixed sender_batch_id, so PayPal never pays twice.",
    inputSchema: { settlement_id: z.string() },
  },
  async ({ settlement_id }) => {
    try {
      const r = (await call("POST", `/api/settlements/${encodeURIComponent(settlement_id)}/execute`, true)) as any;
      return text({ result: r.result, status: r.settlement.status, batch_status: r.settlement.batch_status });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upstream_payout_status",
  {
    title: "Check payout status",
    description: "Reads the latest PayPal status of a settlement's payout batch and items.",
    inputSchema: { settlement_id: z.string() },
  },
  async ({ settlement_id }) => {
    try {
      const r = (await call("POST", `/api/settlements/${encodeURIComponent(settlement_id)}/sync`, true)) as any;
      return text({
        batch_status: r.settlement.batch_status,
        items: r.settlement.items.map((i: any) => ({ repo: i.repo, amount: i.amount, status: i.transaction_status, fee: i.fee })),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
