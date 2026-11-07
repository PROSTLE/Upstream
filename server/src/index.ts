import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { currentUser, finishGithubLogin, githubLoginAvailable, sessionUser, signOut, startGithubLogin } from "./auth.ts";
import { ingestTokenFor, rotateIngestToken, userById, userIdForIngestToken } from "./users.ts";
import { config, features, repoRoot } from "./config.ts";
import { db, getSetting, initDb, json, LOCAL_USER, now } from "./db.ts";
import { ingest, type IngestPayload } from "./evidence/ingest.ts";
import { cleanTranscriptEvents, importTranscript } from "./evidence/import.ts";
import { buildCandidates } from "./evidence/candidates.ts";
import { activeRun, attributeSession, runsForSession, setActiveRun } from "./attribution/run.ts";
import { evalReport, LABELS, labelsAreBlind, saveLabels } from "./attribution/eval.ts";
import { getPackage, normalizeRepo, resolveMany } from "./resolve/index.ts";
import { badgeSvg, inviteDetails, moneyTrail, packagesForUser, publicActivity, recordInvite, repoSummary, reposWithMoney } from "./public.ts";
import { sessionCredits } from "./credits.ts";
import { auditReport } from "./audit.ts";
import { checkView, cleanupExpiredChecks, failInterruptedChecks, hashIp, isOverHardLimit, startCheck } from "./check.ts";
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
import { currentSubscription, startSubscription, syncSubscription } from "./funding.ts";
import { ledgerEntries, poolSummary } from "./ledger.ts";
import { PayPalError, PayPalNotConfigured, runAsUser } from "./paypal/client.ts";
import { ensureProductAndPlan, activePlanId } from "./paypal/subscriptions.ts";
import { issueStatement, listStatements } from "./paypal/statements.ts";
import { ensureWebhook, webhookId, webhookUrl } from "./paypal/webhooks.ts";
import { receiveWebhook } from "./paypal/events.ts";
import {
  approveSettlement,
  cancelUnclaimed,
  discardDrafts,
  executeSettlement,
  feeEstimate,
  housekeeping,
  payoutThreshold,
  planSettlement,
  replaySettlement,
  syncSettlement,
} from "./settlement.ts";
import { fromMinor } from "./money.ts";
import { backfillMoneyEvents, flowSummary, latestSettlementId, moneyEventsAfter, moneyEventsBetween, subscribe } from "./money/flow.ts";
import { moneyTimeline } from "./money/timeline.ts";
import { SDK_PACKAGE, SDK_VERSION } from "./paypal/sdk.ts";

initDb(config.DATABASE_PATH);
failInterruptedChecks();
backfillMoneyEvents();
const app = express();
app.disable("x-powered-by");
// The proxies in front (TRUST_PROXY_HOPS) are counted from the right of X-Forwarded-For, so req.ip is the visitor
// and anything a visitor puts in that header themselves is ignored. The public check's limits count by it.
app.set("trust proxy", config.TRUST_PROXY_HOPS);

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const bearer = (req: Request) => req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

/** The person behind a dashboard request: the operator's token, or someone signed in with GitHub. */
function who(req: Request): { userId: string; operator: boolean } | null {
  if (config.ADMIN_TOKEN && safeEqual(req.header("x-admin-token") ?? "", config.ADMIN_TOKEN)) return { userId: LOCAL_USER, operator: true };
  const user = sessionUser(req);
  return user ? { userId: user.id, operator: user.id === LOCAL_USER } : null;
}

/** The person whose coding agent holds this token. It can write evidence and read its own sessions back, nothing else. */
function agentOwner(req: Request): string | null {
  const token = bearer(req);
  if (!token) return null;
  if (config.INGEST_TOKEN && safeEqual(token, config.INGEST_TOKEN)) return LOCAL_USER;
  return userIdForIngestToken(token) ?? null;
}

/** Whose space this request sees. An unauthenticated read only gets this far when DASHBOARD_ACCESS=public: the operator's demo. */
const scope = (req: Request) => who(req)?.userId ?? agentOwner(req) ?? LOCAL_USER;

const SIGN_IN = "Please sign in first.";

function requireMember(req: Request, res: Response, next: NextFunction) {
  if (!config.ADMIN_TOKEN) return res.status(403).json({ error: "ADMIN_TOKEN is not set on the server, so sign-in and money actions are disabled." });
  if (!who(req)) return res.status(401).json({ error: SIGN_IN });
  next();
}

/** Tasks for the whole server, not one person's space. */
function requireOperator(req: Request, res: Response, next: NextFunction) {
  const w = who(req);
  if (!w) return res.status(401).json({ error: SIGN_IN });
  if (!w.operator) return res.status(403).json({ error: "Only this server's operator can do that." });
  next();
}

/** In live mode everyone's money would sit in the operator's PayPal account, which needs legal review first. Sandbox money is not real. */
function requireTestModeUnlessOperator(req: Request, res: Response, next: NextFunction) {
  if (config.PAYPAL_ENV !== "sandbox" && !who(req)?.operator) return res.status(403).json({ error: "On this server, only the operator can move live money." });
  next();
}

function memberRead(req: Request, res: Response, next: NextFunction) {
  if (config.DASHBOARD_ACCESS === "public" || who(req)) return next();
  res.status(401).json({ error: SIGN_IN });
}

function sessionRead(req: Request, res: Response, next: NextFunction) {
  if (config.DASHBOARD_ACCESS === "public" || who(req) || agentOwner(req)) return next();
  res.status(401).json({ error: SIGN_IN });
}

// Anything addressed by id answers "unknown" to anyone but its owner, so ids can't be probed.
const ownerOf = (sql: string, id: string) => (db().prepare(sql).get(id) as { user_id: string } | undefined)?.user_id;
const ownedBy = (sql: string, notFound: string, param: string) => (req: Request, res: Response, next: NextFunction) => {
  if (ownerOf(sql, String(req.params[param])) !== scope(req)) return res.status(404).json({ error: notFound });
  next();
};
const ownSession = ownedBy("SELECT user_id FROM sessions WHERE id = ?", "Unknown session", "id");
const ownSettlement = ownedBy("SELECT user_id FROM settlements WHERE id = ?", "Unknown settlement", "id");
const ownTopup = ownedBy("SELECT user_id FROM topups WHERE id = ?", "Unknown top-up", "id");
const ownPayoutItem = ownedBy("SELECT s.user_id FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE p.sender_item_id = ?", "Unknown payout item", "senderItemId");

const UPLOAD_LIMIT = "10mb";

// PayPal webhooks need the exact raw body for signature verification.
app.post("/api/paypal/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const result = await receiveWebhook(req.headers, raw);
  res.status(200).json(result);
});

// Session files can be large, so this route has its own limit and runs before the global parser, like the webhook above. Sign-in is checked before the body is read.
app.post("/api/sessions/import", requireMember, express.json({ limit: UPLOAD_LIMIT }), (req, res) => {
  const events = cleanTranscriptEvents(req.body?.events);
  res.json(importTranscript(events, scope(req)));
});

// The public check page. No sign-in, so an address over its hard limit is turned away before the upload is read.
app.post(
  "/api/check",
  (req, res, next) => {
    if (!config.PUBLIC_CHECK_ENABLED) return res.status(404).json({ error: "Public checks are turned off on this server." });
    if (isOverHardLimit(hashIp(req.ip ?? ""))) return res.status(429).json({ error: "Too many checks from this address. Try again in an hour." });
    next();
  },
  express.json({ limit: UPLOAD_LIMIT }),
  (req, res) => {
    const { id } = startCheck({ events: req.body?.events, fileName: req.body?.file_name, stats: req.body?.stats, warnings: req.body?.warnings, ipHash: hashIp(req.ip ?? "") });
    res.json({ id });
  },
);

app.use(express.json({ limit: "4mb" }));
// PayPal calls made while handling a request appear in that person's own call log.
app.use((req, _res, next) => runAsUser(scope(req), next));

// ---------- Ingest from the Claude Code hook ----------
app.post("/api/ingest", (req, res) => {
  if (!config.INGEST_TOKEN) return res.status(503).json({ error: "INGEST_TOKEN is not set on the server." });
  const owner = agentOwner(req);
  if (!owner) return res.status(401).json({ error: "Bad ingest token." });
  const batch = Array.isArray(req.body) ? (req.body as IngestPayload[]) : [req.body as IngestPayload];
  const results = batch.map((p) => {
    try {
      return ingest(p, owner);
    } catch (e) {
      return { error: String(e) };
    }
  });
  res.json({ results });
});

// ---------- Overview & health ----------
app.get("/api/overview", memberRead, (req, res) => {
  const currency = config.TITHE_CURRENCY;
  const userId = scope(req);
  const operator = userId === LOCAL_USER;
  const count = (sql: string) => Number((db().prepare(sql).get(userId) as { n: number }).n);
  const fee = feeEstimate(currency);
  const pkgs = packagesForUser(userId);
  const repos = new Set(pkgs.map((p) => getPackage(p.ecosystem as Ecosystem, p.name)?.repo).filter((r): r is string => Boolean(r)));
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
      max_fee_share: config.POLICY_MAX_FEE_SHARE,
      fee_estimate: fromMinor(fee.minor, currency),
      fee_estimate_source: fee.source,
      payout_threshold: fromMinor(payoutThreshold(currency, fee.minor), currency),
      // The steepest fee on this person's payouts so far, so the "at most" claim can say when an older payout went over it.
      highest_fee_share: (db().prepare("SELECT MAX(1.0 * p.fee_minor / p.amount_minor) AS m FROM payout_items p JOIN settlements s ON s.id = p.settlement_id WHERE s.user_id = ? AND p.fee_minor > 0").get(userId) as { m: number | null }).m,
      reserve_days: config.POLICY_RESERVE_DAYS,
      cancel_unclaimed_after_days: config.POLICY_CANCEL_UNCLAIMED_AFTER_DAYS,
    },
    model: config.UPSTREAM_MODEL,
    viewer: { operator, login: userById(userId)?.login ?? null },
    pool: poolSummary(currency, userId),
    subscription: currentSubscription(userId) ?? null,
    plan_id: activePlanId() ?? null,
    webhook: { id: webhookId() ?? null, url: webhookUrl() },
    counts: {
      sessions: count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?"),
      attributed: count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND status = 'attributed'"),
      evidence: count("SELECT COUNT(*) AS n FROM evidence e JOIN sessions s ON s.id = e.session_id WHERE s.user_id = ?"),
      packages: pkgs.length,
      verified_claims: [...repos].filter((r) => payableClaim(r)).length,
      settlements: count("SELECT COUNT(*) AS n FROM settlements WHERE user_id = ? AND status != 'empty'"),
      webhooks: operator ? Number((db().prepare("SELECT COUNT(*) AS n FROM webhook_events").get() as { n: number }).n) : 0,
    },
    recent_paypal_calls: db().prepare("SELECT * FROM paypal_calls WHERE user_id = ? ORDER BY id DESC LIMIT 12").all(userId),
    recent_webhooks: operator
      ? db().prepare("SELECT id, event_type, received_at, verification_status, processed_at, process_error FROM webhook_events ORDER BY received_at DESC LIMIT 12").all()
      : [],
  });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: now(), brand: config.BRAND_NAME, features, paypal_env: config.PAYPAL_ENV, public_base_url: config.PUBLIC_BASE_URL, dashboard_access: config.DASHBOARD_ACCESS, source_url: config.SOURCE_REPO_URL, public_check: config.PUBLIC_CHECK_ENABLED });
});

// ---------- Sign in with GitHub ----------
app.get("/api/auth/me", (req, res) => {
  const user = currentUser(req);
  res.json({
    user: user && { login: user.login, name: user.name, avatar_url: user.avatar_url, role: user.id === LOCAL_USER ? "operator" : "member" },
    github_login_available: githubLoginAvailable(),
  });
});

app.get("/api/auth/github/start", (_req, res) => {
  try {
    res.redirect(startGithubLogin(res));
  } catch (e) {
    res.redirect(`/?auth_error=${encodeURIComponent((e as Error).message)}`);
  }
});

app.get("/api/auth/github/callback", async (req, res) => {
  try {
    await finishGithubLogin(req, res);
    res.redirect("/dashboard");
  } catch (e) {
    res.redirect(`/?auth_error=${encodeURIComponent((e as Error).message)}`);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  signOut(res);
  res.json({ ok: true });
});

// What this person's coding agent connects with. Only they can see it.
app.get("/api/me/connect", requireMember, (req, res) => {
  const userId = scope(req);
  res.json({ server_url: config.PUBLIC_BASE_URL, token: ingestTokenFor(userId), can_rotate: userId !== LOCAL_USER });
});

app.post("/api/me/connect/rotate", requireMember, (req, res) => {
  res.json({ server_url: config.PUBLIC_BASE_URL, token: rotateIngestToken(scope(req)), can_rotate: true });
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

app.post("/api/setup/paypal", requireOperator, async (_req, res) => {
  const plan = await ensureProductAndPlan();
  const hook = await ensureWebhook();
  res.json({ plan, webhook: hook });
});

// ---------- Sessions & evidence ----------
app.get("/api/sessions", sessionRead, (req, res) => {
  const rows = db()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM evidence e WHERE e.session_id = s.id) AS evidence_count,
              (SELECT COUNT(*) FROM hook_events h WHERE h.session_id = s.id) AS event_count
       FROM sessions s WHERE s.user_id = ? ORDER BY s.last_event_at DESC LIMIT 500`,
    )
    .all(scope(req)) as any[];
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
        source: r.source,
        allocated_settlement_id: r.allocated_settlement_id,
        evidence_count: r.evidence_count,
        event_count: r.event_count,
        top: run?.validated.weights.filter((w) => w.weight > 0).slice(0, 4).map((w) => ({ name: w.name, ecosystem: w.ecosystem, weight: w.weight })) ?? [],
        method: run?.method ?? null,
      };
    }),
  );
});

app.get("/api/sessions/:id", sessionRead, ownSession, async (req, res) => {
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

app.get("/api/sessions/:id/credits", sessionRead, ownSession, (req, res) => {
  const c = sessionCredits(String(req.params.id));
  if (!c) return res.status(404).json({ error: "This session has no attribution yet." });
  res.json(c);
});

// Raw payloads carry the developer's own code (file heads, Edit diffs) and commands: admin only, even when the dashboard is public.
app.get("/api/sessions/:id/events/:eventId", requireMember, ownSession, (req, res) => {
  const row = db()
    .prepare("SELECT * FROM hook_events WHERE session_id = ? AND id = ?")
    .get(String(req.params.id), Number(req.params.eventId)) as any;
  if (!row) return res.status(404).json({ error: "Unknown event" });
  res.json({ ...row, payload: json(row.payload_json, null), payload_json: undefined });
});

app.post("/api/sessions/:id/close", requireMember, ownSession, (req, res) => {
  db().prepare("UPDATE sessions SET status = 'closed', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, 'closed_in_dashboard') WHERE id = ? AND status = 'open'").run(now(), String(req.params.id));
  res.json({ ok: true });
});

app.post("/api/sessions/:id/attribute", requireMember, ownSession, async (req, res) => {
  const w = who(req)!;
  if (!w.operator && features.llm) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const used = Number((db().prepare("SELECT COUNT(*) AS n FROM attribution_runs r JOIN sessions s ON s.id = r.session_id WHERE s.user_id = ? AND r.method = 'llm' AND r.created_at > ?").get(w.userId, since) as { n: number }).n);
    if (used >= config.POLICY_MAX_REVIEWS_PER_DAY) return res.status(429).json({ error: `You've used today's ${config.POLICY_MAX_REVIEWS_PER_DAY} AI reviews. Try again tomorrow.` });
  }
  res.json(await attributeSession(String(req.params.id)));
});

app.post("/api/sessions/:id/active-run", requireMember, ownSession, (req, res) => {
  const runId = String(req.body?.run_id ?? "");
  const run = runsForSession(String(req.params.id)).find((r) => r.id === runId);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  if (run.method === "manifest") return res.status(400).json({ error: "comparison only" });
  const locked = db().prepare("SELECT allocated_settlement_id FROM sessions WHERE id = ?").get(String(req.params.id)) as { allocated_settlement_id: string | null } | undefined;
  if (locked?.allocated_settlement_id) return res.status(409).json({ error: "This session is already part of a payout; the attribution that paid it can't be swapped." });
  setActiveRun(String(req.params.id), runId);
  res.json({ ok: true });
});

app.put("/api/sessions/:id/labels", requireMember, ownSession, (req, res) => {
  const sid = String(req.params.id);
  const labels = (req.body?.labels ?? []) as { ecosystem: string; package: string; label: string; weight?: number | null }[];
  const bad = labels.find((l) => !LABELS.has(l.label));
  if (bad) return res.status(400).json({ error: `Invalid label ${bad.label}` });
  saveLabels(sid, labels);
  res.json({ ok: true, count: labels.length, blind: labelsAreBlind(sid) });
});

app.get("/api/eval", memberRead, (req, res) => res.json(evalReport(scope(req))));

// ---------- Packages & maintainers ----------
app.get("/api/packages", memberRead, (req, res) => {
  const userId = scope(req);
  const rows = packagesForUser(userId) as { ecosystem: Ecosystem; name: string }[];
  const currency = config.TITHE_CURRENCY;
  res.json(
    rows.map((r) => {
      const p = getPackage(r.ecosystem, r.name)!;
      const claim = p.repo ? payableClaim(p.repo) : undefined;
      const sums = p.repo
        ? (db()
            .prepare(
              "SELECT status, COALESCE(SUM(amount_minor),0) AS t FROM allocations WHERE repo = ? AND currency = ? AND user_id = ? AND status IN ('reserved','in_batch','paid') GROUP BY status",
            )
            .all(p.repo, currency, userId) as { status: string; t: number }[])
        : [];
      const s = (k: string) => fromMinor(Number(sums.find((x) => x.status === k)?.t ?? 0), currency);
      const invited = p.repo ? (db().prepare("SELECT created_at FROM invites WHERE repo = ? AND user_id = ?").get(p.repo, userId) as { created_at: string } | undefined) : undefined;
      return {
        ...p,
        sources: undefined,
        repo_conflict: (p.sources as any)?.repo_conflict ?? null,
        claim: claim ? { id: claim.id, method: claim.method, github_login: claim.github_login, verified_at: claim.verified_at } : null,
        invited_at: invited?.created_at ?? null,
        reserved: s("reserved"),
        in_flight: s("in_batch"),
        paid: s("paid"),
        currency,
      };
    }),
  );
});

app.post("/api/packages/refresh", requireMember, async (req, res) => {
  // Limited to this person's own packages, so nobody can drive unbounded registry lookups.
  const list = packagesForUser(scope(req)) as { ecosystem: Ecosystem; name: string }[];
  res.json({ refreshed: (await resolveMany(list, true)).length });
});

// ---------- Claims ----------
app.get("/api/claims", requireOperator, (_req, res) => {
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

// ---------- Public check page ----------
app.get("/api/check/:id", (req, res) => {
  const view = checkView(String(req.params.id));
  if (!view) return res.status(404).json({ error: "This check doesn't exist, or its 24 hours are up." });
  res.setHeader("Cache-Control", "no-store");
  res.json(view);
});

// ---------- Public maintainer views (read-only) ----------
const repoParam = (req: Request) => normalizeRepo(`https://github.com/${String(req.params.owner)}/${String(req.params.name).replace(/\.svg$/, "")}`);

app.get("/api/public/repos", (_req, res) => res.json(reposWithMoney()));

app.get("/api/public/activity", (_req, res) => res.json(publicActivity()));

// For the "How it's built" page: server-wide counts of how PayPal calls were made, versions, and where this runs. Nothing personal.
app.get("/api/public/stack", (_req, res) => {
  const calls = db().prepare("SELECT client, COUNT(*) AS n, MAX(at) AS last_at FROM paypal_calls GROUP BY client").all() as { client: string; n: number; last_at: string | null }[];
  const by = (c: string) => calls.find((x) => x.client === c) ?? { n: 0, last_at: null };
  res.json({
    paypal_env: config.PAYPAL_ENV,
    sdk: { package: SDK_PACKAGE, version: SDK_VERSION, calls: Number(by("sdk").n), last_at: by("sdk").last_at },
    direct: { calls: Number(by("rest").n), last_at: by("rest").last_at },
    model: config.UPSTREAM_MODEL,
    hosting: process.env.RENDER === "true" ? { provider: "Render", commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null, service: process.env.RENDER_SERVICE_NAME ?? null } : null,
  });
});

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

app.get("/api/trail", memberRead, (req, res) => {
  const repo = normalizeRepo(String(req.query.repo ?? "").replace(/^(?!https?:)/, "https://"));
  if (!repo) return res.status(400).json({ error: "Pass ?repo=github.com/owner/name" });
  res.json(moneyTrail(repo, scope(req)));
});

// What the person's invitation to a maintainer says. It's posted only if they open GitHub's form and press submit themselves.
app.get("/api/invite/:owner/:name", requireMember, (req, res) => {
  const repo = repoParam(req);
  if (!repo) return res.status(400).json({ error: "Not a GitHub repository." });
  const details = inviteDetails(repo, scope(req));
  if ("error" in details) return res.status(404).json(details);
  res.json(details);
});

app.post("/api/invite/:owner/:name/sent", requireMember, (req, res) => {
  const repo = repoParam(req);
  if (!repo) return res.status(400).json({ error: "Not a GitHub repository." });
  recordInvite(repo, scope(req), req.body?.channel);
  res.json({ ok: true });
});

// ---------- Funding (PayPal Subscriptions) ----------
app.get("/api/funding", memberRead, (req, res) => {
  const userId = scope(req);
  const allowance = agentAllowance(userId);
  res.json({
    subscription: currentSubscription(userId) ?? null,
    plan_id: activePlanId() ?? null,
    product_id: getSetting("paypal.product_id") ?? null,
    tithe: { amount: config.TITHE_AMOUNT, currency: config.TITHE_CURRENCY, interval: config.TITHE_INTERVAL_UNIT },
    pool: poolSummary(config.TITHE_CURRENCY, userId),
    topups: listTopups(userId).map((t) => ({ ...t, approve_url: t.status === "CREATED" || t.status === "PAYER_ACTION_REQUIRED" ? t.approve_url : null, amount: fromMinor(t.amount_minor, t.currency) })),
    topup_policy: {
      max: config.POLICY_MAX_TOPUP ?? null,
      agent: allowance && { ...allowance, cap: fromMinor(allowance.cap_minor, config.TITHE_CURRENCY), left: fromMinor(allowance.left_minor, config.TITHE_CURRENCY) },
    },
  });
});

// ---------- Monthly statements (PayPal Agent Toolkit) ----------
app.get("/api/statements", memberRead, (req, res) => res.json(listStatements(scope(req))));

app.post("/api/statements/:month/issue", requireMember, requireTestModeUnlessOperator, async (req, res) => {
  res.json(await issueStatement(scope(req), String(req.params.month), { email: req.body?.email }));
});

// ---------- One-time top-ups (PayPal Orders v2) ----------
app.post("/api/funding/topup", requireMember, requireTestModeUnlessOperator, async (req, res) => {
  const source = req.body?.source === "agent" ? "agent" : "dashboard";
  const t = await startTopup({ userId: scope(req), amount: String(req.body?.amount ?? ""), source, note: req.body?.note ? String(req.body.note) : undefined });
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

app.post("/api/funding/topup/:id/sync", requireMember, ownTopup, async (req, res) => {
  const t = await syncTopup(String(req.params.id));
  res.json({ ...t, approve_url: undefined, amount: fromMinor(t.amount_minor, t.currency) });
});

app.post("/api/funding/subscribe", requireMember, requireTestModeUnlessOperator, async (req, res) => {
  const { id, approveUrl } = await startSubscription(scope(req));
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

app.post("/api/funding/sync", requireMember, async (req, res) => {
  const sub = currentSubscription(scope(req));
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

app.get("/api/settlements", memberRead, (req, res) => {
  const rows = db().prepare("SELECT id FROM settlements WHERE user_id = ? AND status != 'empty' ORDER BY created_at DESC").all(scope(req)) as { id: string }[];
  res.json(rows.map((r) => settlementView(r.id)));
});
app.get("/api/settlements/:id", memberRead, ownSettlement, (req, res) => {
  const v = settlementView(String(req.params.id));
  if (!v) return res.status(404).json({ error: "Unknown settlement" });
  res.json(v);
});
app.post("/api/settlements/plan", requireMember, requireTestModeUnlessOperator, (req, res) => {
  const { settlementId } = planSettlement(scope(req));
  res.json(settlementView(settlementId));
});
app.post("/api/settlements/discard-drafts", requireMember, (req, res) => {
  discardDrafts(scope(req));
  res.json({ ok: true });
});
app.post("/api/settlements/:id/approve", requireMember, ownSettlement, (req, res) => {
  approveSettlement(String(req.params.id));
  res.json(settlementView(String(req.params.id)));
});
app.post("/api/settlements/:id/execute", requireMember, ownSettlement, async (req, res) => {
  const result = await executeSettlement(String(req.params.id));
  res.json({ result, settlement: settlementView(String(req.params.id)) });
});
app.post("/api/settlements/:id/sync", requireMember, ownSettlement, async (req, res) => {
  const result = await syncSettlement(String(req.params.id));
  res.json({ result, settlement: settlementView(String(req.params.id)) });
});
app.post("/api/settlements/:id/replay", requireMember, ownSettlement, async (req, res) => {
  res.json(await replaySettlement(String(req.params.id)));
});
app.post("/api/payout-items/:senderItemId/cancel", requireMember, ownPayoutItem, async (req, res) => {
  res.json(await cancelUnclaimed(String(req.params.senderItemId), { manual: true }));
});
app.post("/api/jobs/housekeeping", requireOperator, async (_req, res) => {
  res.json(await housekeeping());
});

// ---------- Self-audit ----------
app.get("/api/audit", memberRead, (req, res) => res.json(auditReport(scope(req))));

// ---------- Ledger ----------
app.get("/api/ledger", memberRead, (req, res) => {
  const currency = config.TITHE_CURRENCY;
  const userId = scope(req);
  res.json({
    summary: poolSummary(currency, userId),
    entries: (ledgerEntries(userId) as any[]).map((e) => ({ ...e, amount: fromMinor(e.amount_minor, e.currency) })),
    paypal_calls: db().prepare("SELECT * FROM paypal_calls WHERE user_id = ? ORDER BY id DESC LIMIT 200").all(userId),
  });
});

// ---------- Live money events ----------
const sseEvent = (e: { id: number }) => `id: ${e.id}\nevent: money\ndata: ${JSON.stringify(e)}\n\n`;

// A stream of this person's money events. The backlog comes first, then "hello" with the current numbers, then events as they commit.
app.get("/api/money/stream", memberRead, (req, res) => {
  const userId = scope(req);
  res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  const after = Math.max(Number(req.header("last-event-id") ?? req.query.after ?? 0) || 0, 0);
  const { events, more } = moneyEventsAfter(userId, after, 500);
  for (const e of events) res.write(sseEvent(e));
  const lastSent = events.at(-1)?.id ?? after;
  res.write(`event: hello\ndata: ${JSON.stringify({ summary: flowSummary(userId), last_id: lastSent, more, latest_settlement_id: latestSettlementId(userId) })}\n\n`);
  const stop = subscribe(userId, (e) => {
    // An event committed just before the backlog was read can still be on its way here.
    if (e.id > lastSent) res.write(sseEvent(e));
  });
  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    stop();
  });
});

// When each repository's money moved and what happens next, drawn with Bryntum Scheduler on the Money records page.
app.get("/api/money/timeline", memberRead, (req, res) => res.json(moneyTimeline(scope(req))));

// The same events without a stream: polling when streaming isn't available (after=), and Replay (from, to, settlement_id).
app.get("/api/money/events", memberRead, (req, res) => {
  const userId = scope(req);
  const limit = Number(req.query.limit ?? 500) || 500;
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const range = { from: text(req.query.from), to: text(req.query.to), settlementId: text(req.query.settlement_id) };
  const replay = range.from || range.to || range.settlementId || req.query.all === "1";
  const page = replay ? { events: moneyEventsBetween(userId, { ...range, limit }), more: false } : moneyEventsAfter(userId, Math.max(Number(req.query.after ?? 0) || 0, 0), limit);
  res.json({ ...page, summary: flowSummary(userId), last_id: page.events.reduce((m, e) => Math.max(m, e.id), 0), latest_settlement_id: latestSettlementId(userId) });
});

// ---------- Errors ----------
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if ((err as { type?: string })?.type === "entity.too.large") return res.status(413).json({ error: `That upload is over the ${UPLOAD_LIMIT} limit.` });
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
  // Read on each request: a copy kept from startup keeps pointing at old script files after a rebuild, which shows a blank page.
  const page = () =>
    fs
      .readFileSync(path.join(webDist, "index.html"), "utf8")
      .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(config.BRAND_NAME)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(")/, (_m, a: string, b: string) =>
        `${a}${esc(`${config.BRAND_NAME} pays the open-source maintainers your AI coding agent actually relied on, through PayPal.`)}${b}`);
  app.get(/^(?!\/api\/).*/, (_req, res) => res.type("html").send(page()));
}

app.listen(config.PORT, (err?: Error) => {
  // Express hands a failed listen (such as a busy port) to this callback; without this the server would claim to be up and then exit.
  if (err) {
    console.error(`Could not start on port ${config.PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Upstream server on http://localhost:${config.PORT} (public: ${config.PUBLIC_BASE_URL}, PayPal ${config.PAYPAL_ENV})`);
  const missing = Object.entries(features).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.log(`Disabled until configured: ${missing.join(", ")}`);
});

// Public checks are deleted on their own timer: a server with no PayPal keys has no housekeeping job, and the 24-hour promise still holds there.
cleanupExpiredChecks();
setInterval(() => cleanupExpiredChecks(), 10 * 60 * 1000).unref();

// Reconcile open batches and enforce the UNCLAIMED policy hourly, independent of webhook delivery.
if (features.paypal) {
  setInterval(() => {
    housekeeping().catch((e) => console.warn("housekeeping failed:", e));
  }, 60 * 60 * 1000).unref();
}
