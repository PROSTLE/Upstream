import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, features, repoRoot } from "./config.ts";
import { db, getSetting, initDb, json, now } from "./db.ts";
import { ingest, type IngestPayload } from "./evidence/ingest.ts";
import { buildCandidates } from "./evidence/candidates.ts";
import { activeRun, attributeSession, runsForSession, setActiveRun } from "./attribution/run.ts";
import { evalReport, LABELS, labelsAreBlind, saveLabels } from "./attribution/eval.ts";
import { getPackage, normalizeRepo, resolveMany } from "./resolve/index.ts";
import { badgeSvg, moneyTrail, repoSummary, reposWithMoney } from "./public.ts";
import { sessionCredits } from "./credits.ts";
import { auditReport } from "./audit.ts";
import { agentAllowance, captureTopup, listTopups, startTopup, syncTopup } from "./topups.ts";
import type { Ecosystem } from "./evidence/parse.ts";
import {
  claimByToken,
  completeGithubClaim,
  githubAuthorizeUrl,
  githubCallback,
  fundingClaimView,
  listClaims,
  payableClaim,
  paypalLoginCallback,
  paypalLoginStart,
  startFundingTokenClaim,
  updateReceiver,
  verifyFundingTokenClaim,
} from "./claims.ts";
import { currentSubscription, syncSubscription } from "./funding.ts";
import { ledgerEntries, poolSummary } from "./ledger.ts";
import { PayPalError, PayPalNotConfigured } from "./paypal/client.ts";
import { createSubscription, ensureProductAndPlan, activePlanId } from "./paypal/subscriptions.ts";
import { ensureWebhook, webhookId, webhookUrl } from "./paypal/webhooks.ts";
import { receiveWebhook } from "./paypal/events.ts";
import {
  approveSettlement,
  cancelUnclaimed,
  discardDrafts,
  executeSettlement,
  housekeeping,
  planSettlement,
  replaySettlement,
  syncSettlement,
} from "./settlement.ts";
import { fromMinor } from "./money.ts";

initDb(config.DATABASE_PATH);
const app = express();
app.disable("x-powered-by");

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const isAdmin = (req: Request) => Boolean(config.ADMIN_TOKEN) && safeEqual(req.header("x-admin-token") ?? "", config.ADMIN_TOKEN!);
const hasIngestToken = (req: Request) =>
  Boolean(config.INGEST_TOKEN) && safeEqual(req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "", config.INGEST_TOKEN!);

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.ADMIN_TOKEN) return res.status(403).json({ error: "ADMIN_TOKEN is not set on the server, so state-changing actions are disabled." });
  if (!isAdmin(req)) return res.status(401).json({ error: "Admin token required for this action." });
  next();
}

/** Operator data (payouts, ledger, claims, packages). Readable by anyone only when DASHBOARD_ACCESS=public. */
function operatorRead(req: Request, res: Response, next: NextFunction) {
  if (config.DASHBOARD_ACCESS === "public" || isAdmin(req)) return next();
  res.status(401).json({ error: "This dashboard is private. Unlock it with the server's ADMIN_TOKEN." });
}

/**
 * Session evidence. The agent's own machine already holds INGEST_TOKEN (it writes this evidence), so the MCP
 * tools may read it back with that token; the dashboard uses ADMIN_TOKEN.
 */
function sessionRead(req: Request, res: Response, next: NextFunction) {
  if (config.DASHBOARD_ACCESS === "public" || isAdmin(req) || hasIngestToken(req)) return next();
  res.status(401).json({ error: "This dashboard is private. Unlock it with the server's ADMIN_TOKEN." });
}

// PayPal webhooks need the exact raw body for signature verification.
app.post("/api/paypal/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const result = await receiveWebhook(req.headers, raw);
  res.status(200).json(result);
});

app.use(express.json({ limit: "4mb" }));

// ---------- Ingest from the Claude Code hook ----------
app.post("/api/ingest", (req, res) => {
  if (!config.INGEST_TOKEN) return res.status(503).json({ error: "INGEST_TOKEN is not set on the server." });
  const auth = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(auth, config.INGEST_TOKEN)) return res.status(401).json({ error: "Bad ingest token." });
  const batch = Array.isArray(req.body) ? (req.body as IngestPayload[]) : [req.body as IngestPayload];
  const results = batch.map((p) => {
    try {
      return ingest(p);
    } catch (e) {
      return { error: String(e) };
    }
  });
  res.json({ results });
});

// ---------- Overview & health ----------
app.get("/api/overview", operatorRead, (_req, res) => {
  const currency = config.TITHE_CURRENCY;
  const count = (sql: string) => Number((db().prepare(sql).get() as { n: number }).n);
  res.json({
    brand: config.BRAND_NAME,
    environment: config.PAYPAL_ENV,
    public_base_url: config.PUBLIC_BASE_URL,
    features,
    tithe: { amount: config.TITHE_AMOUNT, currency, interval: config.TITHE_INTERVAL_UNIT },
    policy: {
      max_topup: config.POLICY_MAX_TOPUP ?? null,
      max_agent_topup: config.POLICY_MAX_AGENT_TOPUP ?? null,
      max_package_share: config.POLICY_MAX_PACKAGE_SHARE,
      min_payout: config.POLICY_MIN_PAYOUT,
      max_payout: config.POLICY_MAX_PAYOUT,
      fee_reserve: config.POLICY_PAYOUT_FEE_RESERVE,
      reserve_days: config.POLICY_RESERVE_DAYS,
      cancel_unclaimed_after_days: config.POLICY_CANCEL_UNCLAIMED_AFTER_DAYS,
    },
    model: config.UPSTREAM_MODEL,
    pool: poolSummary(currency),
    subscription: currentSubscription() ?? null,
    plan_id: activePlanId() ?? null,
    webhook: { id: webhookId() ?? null, url: webhookUrl() },
    counts: {
      sessions: count("SELECT COUNT(*) AS n FROM sessions"),
      attributed: count("SELECT COUNT(*) AS n FROM sessions WHERE status = 'attributed'"),
      evidence: count("SELECT COUNT(*) AS n FROM evidence"),
      packages: count("SELECT COUNT(*) AS n FROM packages"),
      verified_claims: count("SELECT COUNT(*) AS n FROM claims WHERE status = 'verified'"),
      settlements: count("SELECT COUNT(*) AS n FROM settlements WHERE status != 'empty'"),
      webhooks: count("SELECT COUNT(*) AS n FROM webhook_events"),
    },
    recent_paypal_calls: db().prepare("SELECT * FROM paypal_calls ORDER BY id DESC LIMIT 12").all(),
    recent_webhooks: db()
      .prepare("SELECT id, event_type, received_at, verification_status, processed_at, process_error FROM webhook_events ORDER BY received_at DESC LIMIT 12")
      .all(),
  });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: now(), brand: config.BRAND_NAME, features, paypal_env: config.PAYPAL_ENV, public_base_url: config.PUBLIC_BASE_URL, dashboard_access: config.DASHBOARD_ACCESS });
});

// Web app manifest, named from BRAND_NAME. Icons are rendered by `npm run icons` from one vector mark.
app.get("/api/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json").json({
    name: config.BRAND_NAME,
    short_name: config.BRAND_NAME,
    description: `${config.BRAND_NAME} pays the open-source maintainers your AI coding agent actually relied on, through PayPal.`,
    start_url: "/",
    display: "standalone",
    // The light theme's canvas colour (web/src/styles.css --canvas).
    background_color: "#f6f6f3",
    theme_color: "#f6f6f3",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  });
});

app.post("/api/setup/paypal", requireAdmin, async (_req, res) => {
  const plan = await ensureProductAndPlan();
  const hook = await ensureWebhook();
  res.json({ plan, webhook: hook });
});

// ---------- Sessions & evidence ----------
app.get("/api/sessions", sessionRead, (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM evidence e WHERE e.session_id = s.id) AS evidence_count,
              (SELECT COUNT(*) FROM hook_events h WHERE h.session_id = s.id) AS event_count
       FROM sessions s ORDER BY s.last_event_at DESC LIMIT 500`,
    )
    .all() as any[];
  res.json(
    rows.map((r) => {
      const run = activeRun(r.id);
      return {
        id: r.id,
        project: r.project,
        cwd: r.cwd,
        started_at: r.started_at,
        last_event_at: r.last_event_at,
        ended_at: r.ended_at,
        status: r.status,
        allocated_settlement_id: r.allocated_settlement_id,
        evidence_count: r.evidence_count,
        event_count: r.event_count,
        top: run?.validated.weights.filter((w) => w.weight > 0).slice(0, 4).map((w) => ({ name: w.name, ecosystem: w.ecosystem, weight: w.weight })) ?? [],
        method: run?.method ?? null,
      };
    }),
  );
});

app.get("/api/sessions/:id", sessionRead, async (req, res) => {
  const id = String(req.params.id);
  const session = db().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  if (!session) return res.status(404).json({ error: "Unknown session" });
  const events = db()
    .prepare("SELECT id, hook_event_name, tool_name, received_at FROM hook_events WHERE session_id = ? ORDER BY id")
    .all(id);
  const candidates = await buildCandidates(id, { resolve: false });
  res.json({
    session: { ...session, manifest: json(session.manifest_json, null), py_import_map_json: undefined, manifest_json: undefined },
    events,
    candidates,
    runs: runsForSession(id),
    labels: db().prepare("SELECT * FROM labels WHERE session_id = ?").all(id),
    labels_blind: labelsAreBlind(id),
  });
});

app.get("/api/sessions/:id/credits", sessionRead, (req, res) => {
  const c = sessionCredits(String(req.params.id));
  if (!c) return res.status(404).json({ error: "This session has no attribution yet." });
  res.json(c);
});

// Raw payloads carry the developer's own code (file heads, Edit diffs) and commands: admin only, even when the dashboard is public.
app.get("/api/sessions/:id/events/:eventId", requireAdmin, (req, res) => {
  const row = db()
    .prepare("SELECT * FROM hook_events WHERE session_id = ? AND id = ?")
    .get(String(req.params.id), Number(req.params.eventId)) as any;
  if (!row) return res.status(404).json({ error: "Unknown event" });
  res.json({ ...row, payload: json(row.payload_json, null), payload_json: undefined });
});

app.post("/api/sessions/:id/close", requireAdmin, (req, res) => {
  db().prepare("UPDATE sessions SET status = 'closed', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, 'closed_in_dashboard') WHERE id = ? AND status = 'open'").run(now(), String(req.params.id));
  res.json({ ok: true });
});

app.post("/api/sessions/:id/attribute", requireAdmin, async (req, res) => {
  res.json(await attributeSession(String(req.params.id)));
});

app.post("/api/sessions/:id/active-run", requireAdmin, (req, res) => {
  const runId = String(req.body?.run_id ?? "");
  const run = runsForSession(String(req.params.id)).find((r) => r.id === runId);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  const locked = db().prepare("SELECT allocated_settlement_id FROM sessions WHERE id = ?").get(String(req.params.id)) as { allocated_settlement_id: string | null } | undefined;
  if (locked?.allocated_settlement_id) return res.status(409).json({ error: "This session is already part of a payout; the attribution that paid it can't be swapped." });
  setActiveRun(String(req.params.id), runId);
  res.json({ ok: true });
});

app.put("/api/sessions/:id/labels", requireAdmin, (req, res) => {
  const sid = String(req.params.id);
  const labels = (req.body?.labels ?? []) as { ecosystem: string; package: string; label: string; weight?: number | null }[];
  const bad = labels.find((l) => !LABELS.has(l.label));
  if (bad) return res.status(400).json({ error: `Invalid label ${bad.label}` });
  saveLabels(sid, labels);
  res.json({ ok: true, count: labels.length, blind: labelsAreBlind(sid) });
});

app.get("/api/eval", operatorRead, (_req, res) => res.json(evalReport()));

// ---------- Packages & maintainers ----------
app.get("/api/packages", operatorRead, (_req, res) => {
  const rows = db().prepare("SELECT ecosystem, name FROM packages ORDER BY name").all() as { ecosystem: Ecosystem; name: string }[];
  const currency = config.TITHE_CURRENCY;
  res.json(
    rows.map((r) => {
      const p = getPackage(r.ecosystem, r.name)!;
      const claim = p.repo ? payableClaim(p.repo) : undefined;
      const sums = p.repo
        ? (db()
            .prepare(
              "SELECT status, COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE repo = ? AND currency = ? AND status IN ('reserved','in_batch','paid') GROUP BY status",
            )
            .all(p.repo, currency) as { status: string; t: number }[])
        : [];
      const s = (k: string) => fromMinor(Number(sums.find((x) => x.status === k)?.t ?? 0), currency);
      return {
        ...p,
        sources: undefined,
        repo_conflict: (p.sources as any)?.repo_conflict ?? null,
        claim: claim ? { id: claim.id, method: claim.method, github_login: claim.github_login, verified_at: claim.verified_at } : null,
        reserved: s("reserved"),
        in_flight: s("in_batch"),
        paid: s("paid"),
        currency,
      };
    }),
  );
});

app.post("/api/packages/refresh", requireAdmin, async (req, res) => {
  const items = (req.body?.items ?? []) as { ecosystem: Ecosystem; name: string }[];
  const list = items.length ? items : (db().prepare("SELECT ecosystem, name FROM packages").all() as any[]);
  res.json({ refreshed: (await resolveMany(list, true)).length });
});

// ---------- Claims ----------
app.get("/api/claims", operatorRead, (_req, res) => {
  res.json(
    listClaims().map((c) => ({
      ...c,
      token: undefined,
      paypal_receiver: c.paypal_receiver ? c.paypal_receiver.replace(/^(.).*(@.*)$/, "$1•••$2") : null,
    })),
  );
});

app.get("/api/claims/github/start", (req, res) => {
  try {
    res.redirect(githubAuthorizeUrl(String(req.query.repo ?? "")));
  } catch (e) {
    res.redirect(`/claim?error=${encodeURIComponent((e as Error).message)}`);
  }
});

app.get("/api/claims/github/callback", async (req, res) => {
  try {
    const r = await githubCallback(String(req.query.code ?? ""), String(req.query.state ?? ""));
    res.redirect(`/claim/complete?token=${r.token}&repo=${encodeURIComponent(r.repo)}`);
  } catch (e) {
    res.redirect(`/claim?error=${encodeURIComponent((e as Error).message)}`);
  }
});

app.post("/api/claims/complete", (req, res) => {
  const c = completeGithubClaim(String(req.body?.token ?? ""), String(req.body?.receiver ?? ""));
  res.json({ id: c.id, repo: c.repo, status: c.status });
});

app.post("/api/claims/receiver", (req, res) => {
  const c = updateReceiver(String(req.body?.claim_id ?? ""), String(req.body?.receiver ?? ""), String(req.body?.token ?? ""));
  res.json({ id: c.id, repo: c.repo, status: c.status });
});

app.post("/api/claims/funding-token", (req, res) => {
  const c = startFundingTokenClaim(String(req.body?.repo ?? ""), String(req.body?.receiver ?? ""));
  res.json({ id: c.id, repo: c.repo, token: c.token, instruction: c.instruction });
});

app.post("/api/claims/:id/verify", async (req, res) => {
  const c = await verifyFundingTokenClaim(String(req.params.id));
  res.json({ id: c.id, repo: c.repo, status: c.status });
});

app.get("/api/claims/paypal/start", (req, res) => {
  const back = req.query.token ? "/claim/complete" : "/claim";
  try {
    res.redirect(paypalLoginStart({ token: req.query.token ? String(req.query.token) : undefined, repo: req.query.repo ? String(req.query.repo) : undefined }));
  } catch (e) {
    const q = new URLSearchParams({ error: (e as Error).message });
    if (req.query.token) q.set("token", String(req.query.token));
    if (req.query.repo) q.set("repo", String(req.query.repo));
    res.redirect(`${back}?${q}`);
  }
});

app.get("/api/claims/paypal/callback", async (req, res) => {
  if (req.query.error) return res.redirect(`/claim?error=${encodeURIComponent(`PayPal sign-in was cancelled (${String(req.query.error)}).`)}`);
  try {
    const r = await paypalLoginCallback(String(req.query.code ?? ""), String(req.query.state ?? ""));
    if (r.mode === "github_claim") res.redirect(`/claim/complete?done=${encodeURIComponent(r.claim.repo)}&via=paypal`);
    else res.redirect(`/claim?funding=${encodeURIComponent(r.claim.id)}`);
  } catch (e) {
    res.redirect(`/claim?error=${encodeURIComponent((e as Error).message)}`);
  }
});

app.get("/api/claims/funding/:id", (req, res) => {
  const v = fundingClaimView(String(req.params.id));
  if (!v) return res.status(404).json({ error: "Unknown claim" });
  res.json(v);
});

app.get("/api/claims/public/:token", (req, res) => {
  const c = claimByToken(String(req.params.token));
  if (!c || c.method !== "funding_yml_token") return res.status(404).json({ error: "Unknown claim link" });
  res.json({ repo: c.repo, status: c.status, created_at: c.created_at, verified_at: c.verified_at, brand: config.BRAND_NAME });
});

// ---------- Public maintainer views (read-only) ----------
const repoParam = (req: Request) => normalizeRepo(`https://github.com/${String(req.params.owner)}/${String(req.params.name).replace(/\.svg$/, "")}`);

app.get("/api/public/repos", (_req, res) => res.json(reposWithMoney()));

app.get("/api/public/repos/:owner/:name", (req, res) => {
  const repo = repoParam(req);
  const s = repo ? repoSummary(repo) : undefined;
  if (!s) return res.status(404).json({ error: "No agent has relied on this repository yet." });
  res.json(s);
});

app.get("/api/badge/:owner/:name", (req, res) => {
  const repo = repoParam(req);
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=900");
  res.send(badgeSvg(repo ? repoSummary(repo) : undefined));
});

app.get("/api/trail", operatorRead, (req, res) => {
  const repo = normalizeRepo(String(req.query.repo ?? "").replace(/^(?!https?:)/, "https://"));
  if (!repo) return res.status(400).json({ error: "Pass ?repo=github.com/owner/name" });
  res.json(moneyTrail(repo));
});

// ---------- Funding (PayPal Subscriptions) ----------
app.get("/api/funding", operatorRead, (_req, res) => {
  res.json({
    subscription: currentSubscription() ?? null,
    plan_id: activePlanId() ?? null,
    product_id: getSetting("paypal.product_id") ?? null,
    tithe: { amount: config.TITHE_AMOUNT, currency: config.TITHE_CURRENCY, interval: config.TITHE_INTERVAL_UNIT },
    pool: poolSummary(config.TITHE_CURRENCY),
    topups: listTopups().map((t) => ({ ...t, approve_url: t.status === "CREATED" || t.status === "PAYER_ACTION_REQUIRED" ? t.approve_url : null, amount: fromMinor(t.amount_minor, t.currency) })),
    topup_policy: {
      max: config.POLICY_MAX_TOPUP ?? null,
      agent: agentAllowance() && { ...agentAllowance()!, cap: fromMinor(agentAllowance()!.cap_minor, config.TITHE_CURRENCY), left: fromMinor(agentAllowance()!.left_minor, config.TITHE_CURRENCY) },
    },
  });
});

// ---------- One-time top-ups (PayPal Orders v2) ----------
app.post("/api/funding/topup", requireAdmin, async (req, res) => {
  const source = req.body?.source === "agent" ? "agent" : "dashboard";
  const t = await startTopup({ amount: String(req.body?.amount ?? ""), source, note: req.body?.note ? String(req.body.note) : undefined });
  res.json({ id: t.id, order_id: t.order_id, approveUrl: t.approve_url, amount: fromMinor(t.amount_minor, t.currency), currency: t.currency, source: t.source });
});

// PayPal sends the payer back here after approval; capture happens server side, then the Funding page shows the result.
app.get("/api/funding/topup/return", async (req, res) => {
  const id = String(req.query.topup ?? "");
  try {
    const t = await captureTopup(id);
    res.redirect(`/funding?topup=${encodeURIComponent(id)}&capture=${encodeURIComponent(t.capture_status ?? t.status)}`);
  } catch (e) {
    res.redirect(`/funding?error=${encodeURIComponent((e as Error).message)}`);
  }
});

app.post("/api/funding/topup/:id/sync", requireAdmin, async (req, res) => {
  const t = await syncTopup(String(req.params.id));
  res.json({ ...t, approve_url: undefined, amount: fromMinor(t.amount_minor, t.currency) });
});

app.post("/api/funding/subscribe", requireAdmin, async (_req, res) => {
  const { id, approveUrl } = await createSubscription();
  res.json({ id, approveUrl });
});

app.get("/api/funding/return", async (req, res) => {
  const id = String(req.query.subscription_id ?? "");
  if (!id) return res.redirect("/funding?error=missing_subscription_id");
  try {
    const r = await syncSubscription(id);
    res.redirect(`/funding?subscribed=${encodeURIComponent(id)}&status=${r.status}`);
  } catch (e) {
    res.redirect(`/funding?error=${encodeURIComponent((e as Error).message)}`);
  }
});

app.post("/api/funding/sync", requireAdmin, async (_req, res) => {
  const sub = currentSubscription();
  if (!sub) return res.status(400).json({ error: "No subscription yet." });
  res.json(await syncSubscription(sub.id));
});

// ---------- Settlements (PayPal Payouts) ----------
function settlementView(id: string) {
  const s = db().prepare("SELECT * FROM settlements WHERE id = ?").get(id) as any;
  if (!s) return undefined;
  const items = db().prepare("SELECT * FROM payout_items WHERE settlement_id = ? ORDER BY sender_item_id").all(id) as any[];
  const allocations = db()
    .prepare("SELECT * FROM allocations WHERE settlement_id = ? OR payout_item_ref IN (SELECT sender_item_id FROM payout_items WHERE settlement_id = ?) ORDER BY amount_minor DESC")
    .all(id, id) as any[];
  return {
    ...s,
    planned: fromMinor(s.planned_minor, s.currency),
    reserved: fromMinor(s.reserved_minor, s.currency),
    fee_reserve: fromMinor(s.fee_reserve_minor, s.currency),
    policy: json(s.policy_json, {}),
    error: json(s.error_json, null),
    request: json(s.request_json, null),
    policy_json: undefined,
    error_json: undefined,
    request_json: undefined,
    items: items.map((i) => ({
      ...i,
      amount: fromMinor(i.amount_minor, i.currency),
      fee: i.fee_minor != null ? fromMinor(i.fee_minor, i.currency) : null,
      errors: json(i.errors_json, null),
      receiver: i.receiver.replace(/^(.).*(@.*)$/, "$1•••$2"),
    })),
    allocations: allocations.map((a) => ({ ...a, amount: fromMinor(a.amount_minor, a.currency), session_ids: json(a.session_ids_json, []) })),
  };
}

app.get("/api/settlements", operatorRead, (_req, res) => {
  const rows = db().prepare("SELECT id FROM settlements WHERE status != 'empty' ORDER BY created_at DESC").all() as { id: string }[];
  res.json(rows.map((r) => settlementView(r.id)));
});
app.get("/api/settlements/:id", operatorRead, (req, res) => {
  const v = settlementView(String(req.params.id));
  if (!v) return res.status(404).json({ error: "Unknown settlement" });
  res.json(v);
});
app.post("/api/settlements/plan", requireAdmin, (_req, res) => {
  const { settlementId } = planSettlement();
  res.json(settlementView(settlementId));
});
app.post("/api/settlements/discard-drafts", requireAdmin, (_req, res) => {
  discardDrafts();
  res.json({ ok: true });
});
app.post("/api/settlements/:id/approve", requireAdmin, (req, res) => {
  approveSettlement(String(req.params.id));
  res.json(settlementView(String(req.params.id)));
});
app.post("/api/settlements/:id/execute", requireAdmin, async (req, res) => {
  const result = await executeSettlement(String(req.params.id));
  res.json({ result, settlement: settlementView(String(req.params.id)) });
});
app.post("/api/settlements/:id/sync", requireAdmin, async (req, res) => {
  const result = await syncSettlement(String(req.params.id));
  res.json({ result, settlement: settlementView(String(req.params.id)) });
});
app.post("/api/settlements/:id/replay", requireAdmin, async (req, res) => {
  res.json(await replaySettlement(String(req.params.id)));
});
app.post("/api/payout-items/:senderItemId/cancel", requireAdmin, async (req, res) => {
  res.json(await cancelUnclaimed(String(req.params.senderItemId), { manual: true }));
});
app.post("/api/jobs/housekeeping", requireAdmin, async (_req, res) => {
  res.json(await housekeeping());
});

// ---------- Self-audit ----------
app.get("/api/audit", operatorRead, (_req, res) => res.json(auditReport()));

// ---------- Ledger ----------
app.get("/api/ledger", operatorRead, (_req, res) => {
  const currency = config.TITHE_CURRENCY;
  res.json({
    summary: poolSummary(currency),
    entries: (ledgerEntries() as any[]).map((e) => ({ ...e, amount: fromMinor(e.amount_minor, e.currency) })),
    paypal_calls: db().prepare("SELECT * FROM paypal_calls ORDER BY id DESC LIMIT 200").all(),
  });
});

// ---------- Errors ----------
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof PayPalNotConfigured) return res.status(503).json({ error: err.message });
  if (err instanceof PayPalError) {
    return res.status(502).json({ error: err.message, paypal_status: err.status, paypal_body: err.body, debug_id: err.debugId });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  res.status(400).json({ error: message });
});

// ---------- Web app ----------
const webDist = path.join(repoRoot, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: false, maxAge: "1h" }));
  // The built page names the product from BRAND_NAME, so the title is right before any script runs.
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const page = fs
    .readFileSync(path.join(webDist, "index.html"), "utf8")
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(config.BRAND_NAME)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, (_m, a: string, b: string) =>
      `${a}${esc(`${config.BRAND_NAME} pays the open-source maintainers your AI coding agent actually relied on, through PayPal.`)}${b}`);
  app.get(/^(?!\/api\/).*/, (_req, res) => res.type("html").send(page));
}

app.listen(config.PORT, () => {
  console.log(`Upstream server on http://localhost:${config.PORT} (public: ${config.PUBLIC_BASE_URL}, PayPal ${config.PAYPAL_ENV})`);
  const missing = Object.entries(features).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.log(`Disabled until configured: ${missing.join(", ")}`);
});

// Reconcile open batches and enforce the UNCLAIMED policy hourly, independent of webhook delivery.
if (features.paypal) {
  setInterval(() => {
    housekeeping().catch((e) => console.warn("housekeeping failed:", e));
  }, 60 * 60 * 1000).unref();
}
