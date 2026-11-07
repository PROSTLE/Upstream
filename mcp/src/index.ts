#!/usr/bin/env node
// Upstream MCP server: gives a coding agent a guarded view of PayPal Payouts.
// The agent can inspect evidence, propose a settlement and send a batch a human already approved.
// It can never choose receivers or amounts: those come from validated attribution and verified claims.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// An optional plugin setting left empty can arrive unsubstituted ("${user_config.x}"); treat that as unset.
const setting = (v: string | undefined) => (v && !/^\$\{.*\}$/.test(v.trim()) ? v.trim() : undefined);
// The hook installer keeps the URL and ingest token in ~/.upstream/config.json (mode 600), never in .mcp.json.
const saved = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".upstream", "config.json"), "utf8")) as { url?: string; token?: string };
  } catch {
    return {};
  }
})();
const BASE = (setting(process.env.UPSTREAM_URL) ?? saved.url)?.replace(/\/+$/, "");
const ADMIN = setting(process.env.UPSTREAM_ADMIN_TOKEN);
// Reading session evidence back needs the same token the hook writes it with when the server's dashboard is private.
const INGEST = setting(process.env.UPSTREAM_INGEST_TOKEN) ?? saved.token;

async function call(method: "GET" | "POST", path: string, admin = false, payload: unknown = {}): Promise<unknown> {
  if (!BASE) throw new Error("UPSTREAM_URL is not set for the Upstream MCP server.");
  if (admin && !ADMIN) throw new Error("UPSTREAM_ADMIN_TOKEN is not set, so payout actions are disabled for this agent.");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(INGEST ? { authorization: `Bearer ${INGEST}` } : {}),
      ...(admin ? { "x-admin-token": ADMIN! } : {}),
    },
    body: method === "POST" ? JSON.stringify(payload) : undefined,
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
        reserved_for_unclaimed_repos: `${s.reserved} ${s.currency}`,
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

server.registerTool(
  "upstream_session_credits",
  {
    title: "Open-source credits for a pull request",
    description:
      "Returns a Markdown 'Open-source credits' block for a session: the packages the agent relied on, their role, share and the reason, from Upstream's validated attribution. Paste it into the PR description.",
    inputSchema: { session_id: z.string().optional().describe("Defaults to the most recently active session.") },
  },
  async ({ session_id }) => {
    try {
      let id = session_id;
      if (!id) id = ((await call("GET", "/api/sessions")) as { id: string }[])[0]?.id;
      if (!id) return text({ message: "No sessions recorded yet. Is the Upstream hook installed?" });
      const c = (await call("GET", `/api/sessions/${encodeURIComponent(id)}/credits`)) as { markdown: string };
      return { content: [{ type: "text" as const, text: c.markdown }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upstream_issue_statement",
  {
    title: "Issue a monthly funding statement",
    description:
      "Issues a month's funding statement as a PayPal invoice marked paid, listing each payment PayPal confirmed and where the money went. It moves no money and emails nobody. Issuing the same month again returns the same invoice. Only call this when the user asks for a statement.",
    inputSchema: { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe("The month, for example 2026-11.") },
  },
  async ({ month }) => {
    try {
      const r = (await call("POST", `/api/statements/${month}/issue`, true)) as any;
      return text({ month: r.month, invoice_id: r.invoice_id, status: r.status, view_url: r.view_url, payments_recorded_by_note_only: r.fell_back });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upstream_request_funding",
  {
    title: "Ask the user to top up the open-source pool",
    description:
      "Creates a one-time PayPal top-up of the Upstream pool and returns a PayPal approval link for the USER to open. No money moves until the user approves it on PayPal's own page. The server caps agent requests per 24 hours (POLICY_MAX_AGENT_TOPUP) and refuses when agent top-ups are off. Only call this when the user asks to add money.",
    inputSchema: {
      amount: z.string().regex(/^\d+(\.\d+)?$/).describe("Amount in the pool's currency, e.g. \"10.00\"."),
      reason: z.string().max(200).optional().describe("Short note shown with the top-up in the dashboard."),
    },
  },
  async ({ amount, reason }) => {
    try {
      const r = (await call("POST", "/api/funding/topup", true, { amount, note: reason, source: "agent" })) as any;
      return text({
        approve_url: r.approveUrl,
        amount: `${r.amount} ${r.currency}`,
        next_step: "Show the user this PayPal link. The payment only happens if they approve it on PayPal; the Upstream server captures it when they return.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
