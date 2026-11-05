// Two people on one server must never see or spend each other's data or money. PayPal is an in-process stand-in that exists only in tests.
import "./helpers/env.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const { openDb, setDbForTests, db, now } = await import("../src/db.ts");
const { setPayPalFetch } = await import("../src/paypal/client.ts");
const { book, ledgerEntries, poolSummary } = await import("../src/ledger.ts");
const { ingest } = await import("../src/evidence/ingest.ts");
const { sealSession } = await import("../src/auth.ts");
const { auditReport } = await import("../src/audit.ts");
const { evalReport } = await import("../src/attribution/eval.ts");
const { currentSubscription, startSubscription, syncSubscription, upsertSubscription } = await import("../src/funding.ts");
const { listTopups, startTopup, syncTopup } = await import("../src/topups.ts");
const { moneyTrail, packagesForUser } = await import("../src/public.ts");
const { userForGithub } = await import("../src/users.ts");
const s = await import("../src/settlement.ts");

const ALICE = "u_alice";
const BOB = "u_bob";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const paypalCustomIds: (string | undefined)[] = [];

before(() => {
  setDbForTests(openDb(":memory:"));
  setPayPalFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "t", expires_in: 3600 });
    if (url.pathname === "/v1/catalogs/products") return json(201, { id: "PROD-1" });
    if (url.pathname === "/v1/billing/plans") return json(201, { id: "P-1", status: "ACTIVE" });
    if (url.pathname === "/v1/billing/subscriptions" && init?.method === "POST") {
      paypalCustomIds.push(JSON.parse(String(init.body)).custom_id);
      return json(201, { id: "I-ALICE", plan_id: "P-1", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://paypal.example/approve" }] });
    }
    if (url.pathname === "/v1/billing/subscriptions/I-ALICE") return json(200, { id: "I-ALICE", plan_id: "P-1", status: "ACTIVE", custom_id: ALICE });
    if (url.pathname === "/v1/billing/subscriptions/I-ALICE/transactions") {
      return json(200, { transactions: [{ id: "TX1", status: "COMPLETED", time: now(), amount_with_breakdown: { gross_amount: { currency_code: "USD", value: "10.00" }, fee_amount: { currency_code: "USD", value: "0.84" } } }] });
    }
    if (url.pathname === "/v1/billing/subscriptions/I-STRANGER") return json(200, { id: "I-STRANGER", plan_id: "P-1", status: "ACTIVE", custom_id: "u_nobody" });
    if (url.pathname === "/v2/checkout/orders" && init?.method === "POST") return json(201, { id: "O-BOB", status: "CREATED", links: [{ rel: "payer-action", href: "https://paypal.example/pay" }] });
    if (url.pathname === "/v2/checkout/orders/O-BOB") {
      return json(200, { id: "O-BOB", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-BOB", status: "COMPLETED", create_time: now(), amount: { value: "20.00", currency_code: "USD" }, seller_receivable_breakdown: { gross_amount: { value: "20.00", currency_code: "USD" }, paypal_fee: { value: "1.00", currency_code: "USD" } } }] } }] });
    }
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      return json(201, { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING", sender_batch_header: JSON.parse(String(init.body)).sender_batch_header } });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  }) as typeof fetch);
  const d = db();
  for (const [id, gh, login] of [[ALICE, "1", "alice"], [BOB, "2", "bob"]]) {
    d.prepare("INSERT INTO users(id, github_id, login, ingest_token, created_at) VALUES (?,?,?,?,?)").run(id, gh, login, `token-${login}`, now());
  }
  d.prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod'), ('npm','dayjs','github.com/iamkun/dayjs')").run();
  d.prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, evidence_json, created_at, verified_at) VALUES ('c1','github.com/colinhacks/zod','github_admin','m@example.com','verified','{\"permissions\":{\"admin\":true}}',?,?)").run(now(), now());
});

function attributed(userId: string, sessionId: string, pkg: string) {
  ingest({ session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `install-${pkg}`, cwd: `/home/${userId}/secret-project`, tool_input: { command: `npm install ${pkg}` } }, userId);
  const id = `${userId}.${sessionId}`;
  const evidence = (db().prepare("SELECT id FROM evidence WHERE session_id = ?").all(id) as { id: string }[]).map((e) => e.id);
  assert.ok(evidence.length, "the hook event produced evidence");
  const validated = { weights: [{ ecosystem: "npm", name: pkg, weight: 0.5, classification: "meaningful", evidence_ids: evidence, rationale: "", proposed_weight: 1 }], unallocated: 0.5, flags: [] };
  const candidates = { candidates: [{ ecosystem: "npm", name: pkg, evidence_ids: evidence }], evidence: [], unattributed: [] };
  db().prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES (?,?,?,'llm',?,?,'[]',1)").run(`run-${id}`, id, now(), JSON.stringify(candidates), JSON.stringify(validated));
  db().prepare("UPDATE sessions SET status = 'attributed' WHERE id = ?").run(id);
  return id;
}

test("the same session and tool ids from two people stay separate, so nobody can write into another's session", () => {
  const event = { session_id: "same-session", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "same-tool", cwd: "/p", tool_input: { command: "npm install zod" } };
  assert.equal(ingest(event, ALICE).stored, true);
  assert.equal(ingest(event, BOB).stored, true, "Bob's event isn't dropped as a duplicate of Alice's");
  assert.equal(ingest(event, BOB).stored, false, "but his own repeat is");
  const rows = db().prepare("SELECT id, user_id FROM sessions WHERE id LIKE '%same-session' ORDER BY id").all() as { id: string; user_id: string }[];
  assert.deepEqual(rows.map((r) => r.user_id), [ALICE, BOB]);
  assert.notEqual(rows[0].id, rows[1].id);
});

test("a subscription pays into the account that started it, and one nobody here started is ignored", async () => {
  const { id } = await startSubscription(ALICE);
  assert.deepEqual(paypalCustomIds, [ALICE], "PayPal is told the owner too");
  assert.equal(currentSubscription(ALICE)?.id, id);
  assert.equal(currentSubscription(BOB), undefined);

  await syncSubscription(id);
  assert.equal(poolSummary("USD", ALICE).available, 916);
  assert.equal(poolSummary("USD", BOB).available, 0);
  assert.equal(ledgerEntries(BOB).length, 0);

  assert.equal(upsertSubscription({ id: "I-STRANGER", plan_id: "P-1", status: "ACTIVE", custom_id: "u_nobody" }), false);
  await assert.rejects(syncSubscription("I-STRANGER"), /isn't linked to an account/);
  assert.equal(poolSummary("USD", ALICE).available, 916, "a stranger's subscription adds nothing");
});

test("a top-up belongs to whoever started it", async () => {
  const t = await startTopup({ userId: BOB, amount: "20", source: "dashboard" });
  assert.equal(listTopups(ALICE).length, 0);
  assert.equal(listTopups(BOB).length, 1);
  await syncTopup(t.id);
  assert.equal(poolSummary("USD", BOB).available, 1900);
  assert.equal(poolSummary("USD", ALICE).available, 916, "Alice's balance doesn't change");
});

test("a payout spends only its owner's money, sessions and held funds", async () => {
  const aliceSession = attributed(ALICE, "a1", "dayjs"); // no verified maintainer: held
  const bobSession = attributed(BOB, "b1", "zod"); // verified maintainer: paid

  const a = s.planSettlement(ALICE);
  const aPlan = db().prepare("SELECT * FROM settlements WHERE id = ?").get(a.settlementId) as any;
  assert.deepEqual(JSON.parse(aPlan.policy_json).sessions, [aliceSession], "Bob's session isn't in Alice's plan");
  assert.equal(aPlan.user_id, ALICE);
  s.approveSettlement(a.settlementId);
  const held = poolSummary("USD", ALICE).reserved;
  assert.ok(held > 0, "Alice's share for dayjs is held for its maintainer");
  assert.equal(poolSummary("USD", BOB).reserved, 0, "and that hold doesn't touch Bob");

  db().prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, evidence_json, created_at, verified_at) VALUES ('c2','github.com/iamkun/dayjs','github_admin','d@example.com','verified','{\"permissions\":{\"admin\":true}}',?,?)").run(now(), now());
  const b = s.planSettlement(BOB);
  const bItems = db().prepare("SELECT repo FROM payout_items WHERE settlement_id = ?").all(b.settlementId) as { repo: string }[];
  assert.deepEqual(bItems.map((i) => i.repo), ["github.com/colinhacks/zod"], "Bob's plan can't release money Alice is holding for dayjs");
  const bPlan = db().prepare("SELECT * FROM settlements WHERE id = ?").get(b.settlementId) as any;
  assert.deepEqual(JSON.parse(bPlan.policy_json).sessions, [bobSession]);
  assert.ok(bPlan.planned_minor <= 1900, "limited by Bob's own balance");

  s.approveSettlement(b.settlementId);
  await s.executeSettlement(b.settlementId);
  s.applyPayoutItem({ payout_item_id: "PI-B", transaction_id: "TX-B", transaction_status: "SUCCESS", payout_batch_id: "PB1", payout_item: { sender_item_id: `${b.settlementId}-1` } } as any, "webhook");
  assert.equal(poolSummary("USD", BOB).payoutsSent, -bPlan.planned_minor, "the payout is booked to Bob");
  assert.equal(poolSummary("USD", ALICE).payoutsSent, 0);
  assert.equal(poolSummary("USD", ALICE).reserved, held, "Alice's hold is untouched");

  s.discardDrafts(BOB);
  assert.ok(db().prepare("SELECT 1 FROM settlements WHERE id = ?").get(a.settlementId), "discarding Bob's drafts leaves Alice's run");
});

test("reports, packages and money trails show only their owner's records", () => {
  assert.deepEqual(packagesForUser(ALICE).map((p) => p.name), ["dayjs"]);
  assert.deepEqual(packagesForUser(BOB).map((p) => p.name), ["zod"]);
  assert.equal(moneyTrail("github.com/colinhacks/zod", ALICE).allocations.length, 0, "Alice can't see Bob's allocation");
  assert.equal(moneyTrail("github.com/colinhacks/zod", BOB).allocations.length, 1);
  assert.equal(moneyTrail("github.com/iamkun/dayjs", BOB).sessions.length, 0, "or Bob Alice's sessions");

  db().prepare("INSERT INTO labels(session_id, ecosystem, package, label, updated_at) VALUES ('u_alice.a1','npm','dayjs','meaningful',?)").run(now());
  assert.equal(evalReport(ALICE).perSession.length, 1);
  assert.equal(evalReport(BOB).perSession.length, 0);

  // A safety problem in one space is reported only to its owner: Bob's batch hasn't been re-read from PayPal yet.
  assert.deepEqual(auditReport(BOB).checks.filter((c) => c.status === "fail").map((c) => c.id), ["open_batches_reconciled"]);
  assert.deepEqual(auditReport(ALICE).checks.filter((c) => c.status === "fail").map((c) => c.id), []);
  db().prepare("UPDATE settlements SET batch_status = 'SUCCESS', synced_at = ? WHERE user_id = ?").run(now(), BOB);

  const alice = auditReport(ALICE);
  const bob = auditReport(BOB);
  assert.deepEqual(alice.checks.filter((c) => c.status === "fail").map((c) => c.failures), []);
  assert.deepEqual(bob.checks.filter((c) => c.status === "fail").map((c) => c.failures), []);
  assert.equal(alice.activity.llm_runs, 1);
  assert.equal(alice.activity.payout_items_confirmed, 0);
  assert.equal(bob.activity.payout_items_confirmed, 1);
});

test("an operator login only reaches the operator's space from the GitHub account that first claimed it", () => {
  const first = userForGithub({ id: 100, login: "boss", name: null, avatar_url: null }, true);
  assert.equal(first.id, "local");
  const reused = userForGithub({ id: 999, login: "boss", name: null, avatar_url: null }, true);
  assert.notEqual(reused.id, "local", "someone who later takes that GitHub name gets their own empty space");
  assert.equal(poolSummary("USD", reused.id).available, 0);
});

// ---------- over real HTTP, as Bob attacking Alice ----------
const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const ADMIN = "admin-test-token";
const running: ChildProcess[] = [];
after(() => running.forEach((p) => p.kill()));

async function start(extra: Record<string, string> = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upstream-spaces-")), "t.db");
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: file, DASHBOARD_ACCESS: "private", ADMIN_TOKEN: ADMIN, INGEST_TOKEN: "operator-ingest-token",
      OPERATOR_GITHUB_LOGINS: "boss", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "", PUBLIC_BASE_URL: `http://localhost:${port}`, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", ...extra,
    },
  });
  running.push(p);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 20_000);
    p.stdout!.on("data", (d) => String(d).includes("server on") && (clearTimeout(t), resolve()));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const sql = new DatabaseSync(file);
  for (const [id, gh, login] of [[ALICE, "1", "alice"], [BOB, "2", "bob"]]) {
    sql.prepare("INSERT INTO users(id, github_id, login, ingest_token, created_at) VALUES (?,?,?,?,?)").run(id, gh, login, `token-${login}`, new Date().toISOString());
  }
  return { base: `http://127.0.0.1:${port}`, sql };
}

const as = (uid: string) => ({ cookie: `upstream_session=${sealSession(uid, ADMIN)}` });
const seed = async (base: string) => {
  const r = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer token-alice" },
    body: JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Edit", cwd: "/home/alice/secret-project", tool_input: { file_path: "/home/alice/secret-project/a.ts", new_string: "alice's private code" } }),
  });
  assert.equal(r.status, 200);
};

test("over HTTP, Bob can't read or act on anything of Alice's", { timeout: 60_000 }, async () => {
  const { base, sql } = await start();
  await seed(base);
  const aliceSession = `${ALICE}.s1`;
  const get = (p: string, headers = {}) => fetch(base + p, { headers });
  const post = (p: string, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

  const mine = (await (await get("/api/sessions", as(ALICE))).json()) as { id: string; project: string }[];
  assert.deepEqual(mine.map((x) => x.id), [aliceSession]);
  assert.equal(mine[0].project, "secret-project");

  for (const who of [as(BOB), { "x-admin-token": ADMIN }, { authorization: "Bearer token-bob" }, { authorization: "Bearer operator-ingest-token" }]) {
    assert.deepEqual(await (await get("/api/sessions", who)).json(), [], "other people's lists are empty");
    assert.equal((await get(`/api/sessions/${aliceSession}`, who)).status, 404, "her session looks like it doesn't exist");
    assert.equal((await get(`/api/sessions/${aliceSession}/credits`, who)).status, 404);
  }
  const eventId = (sql.prepare("SELECT id FROM hook_events").get() as { id: number }).id;
  assert.equal((await get(`/api/sessions/${aliceSession}/events/${eventId}`, as(ALICE))).status, 200, "she can open her raw event");
  assert.equal((await get(`/api/sessions/${aliceSession}/events/${eventId}`, as(BOB))).status, 404, "he can't");
  assert.equal((await get(`/api/sessions/${aliceSession}/events/${eventId}`, { authorization: "Bearer token-alice" })).status, 401, "and an agent token never reads raw payloads");
  for (const action of ["close", "attribute", "active-run"]) assert.equal((await post(`/api/sessions/${aliceSession}/${action}`, as(BOB))).status, 404, action);
  assert.equal((await fetch(`${base}/api/sessions/${aliceSession}/labels`, { method: "PUT", headers: { "content-type": "application/json", ...as(BOB) }, body: '{"labels":[]}' })).status, 404);

  const stamp = new Date().toISOString();
  sql.prepare("INSERT INTO settlements(id, status, currency, pool_minor, planned_minor, reserved_minor, fee_reserve_minor, sender_batch_id, policy_json, created_at, user_id) VALUES ('stl_a','draft','USD',0,0,0,0,'upstream-stl_a','{\"checks\":[],\"sessions\":[]}',?,?)").run(stamp, ALICE);
  sql.prepare("INSERT INTO topups(id, amount_minor, currency, source, status, order_id, created_at, updated_at, user_id) VALUES ('top_a',500,'USD','dashboard','CREATED','O-A',?,?,?)").run(stamp, stamp, ALICE);
  sql.prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, created_at) VALUES ('c1','github.com/o/r','github_admin','m@example.com','verified',?)").run(stamp);
  sql.prepare("INSERT INTO payout_items(sender_item_id, settlement_id, claim_id, repo, receiver, amount_minor, currency, note, allocation_ids_json, updated_at) VALUES ('stl_a-1','stl_a','c1','github.com/o/r','m@example.com',100,'USD','n','{}',?)").run(stamp);
  sql.prepare("INSERT INTO ledger(dedupe_key, occurred_at, kind, amount_minor, currency, source, user_id) VALUES ('k1',?,'FUNDING_GROSS',500,'USD','api_sync',?)").run(stamp, ALICE);

  assert.equal((await get("/api/settlements/stl_a", as(ALICE))).status, 200);
  assert.equal((await get("/api/settlements/stl_a", as(BOB))).status, 404);
  assert.equal(((await (await get("/api/settlements", as(BOB))).json()) as unknown[]).length, 0);
  for (const action of ["approve", "execute", "sync", "replay"]) assert.equal((await post(`/api/settlements/stl_a/${action}`, as(BOB))).status, 404, action);
  assert.equal((await post("/api/payout-items/stl_a-1/cancel", as(BOB))).status, 404);
  assert.equal((await post("/api/funding/topup/top_a/sync", as(BOB))).status, 404);

  const balance = async (who: object) => ((await (await get("/api/funding", who)).json()) as { pool: { fundingGross: number } }).pool.fundingGross;
  assert.equal(await balance(as(ALICE)), 500);
  assert.equal(await balance(as(BOB)), 0, "her money isn't in his pool");
  const ledger = (await (await get("/api/ledger", as(BOB))).json()) as { entries: unknown[] };
  assert.equal(ledger.entries.length, 0);
  assert.deepEqual(((await (await get("/api/funding", as(BOB))).json()) as { topups: unknown[] }).topups, []);

  const overview = (await (await get("/api/overview", as(BOB))).json()) as { counts: { sessions: number; evidence: number }; viewer: { operator: boolean; login: string } };
  assert.deepEqual([overview.counts.sessions, overview.counts.evidence], [0, 0]);
  assert.deepEqual(overview.viewer, { operator: false, login: "bob" });

  for (const p of ["/api/claims"]) assert.equal((await get(p, as(BOB))).status, 403, p);
  for (const p of ["/api/jobs/housekeeping", "/api/setup/paypal"]) assert.equal((await post(p, as(BOB))).status, 403, p);
});

test("each person gets their own agent token, and replacing it stops the old one", { timeout: 60_000 }, async () => {
  const { base } = await start();
  const connect = async (who: object) => (await (await fetch(`${base}/api/me/connect`, { headers: { ...who } })).json()) as { token: string; can_rotate: boolean };
  assert.equal((await connect(as(ALICE))).token, "token-alice");
  assert.equal((await connect(as(BOB))).token, "token-bob");
  assert.equal((await fetch(`${base}/api/me/connect`)).status, 401, "signed out: no token");
  assert.equal((await connect({ "x-admin-token": ADMIN })).can_rotate, false);

  const rotated = (await (await fetch(`${base}/api/me/connect/rotate`, { method: "POST", headers: as(ALICE) })).json()) as { token: string };
  assert.notEqual(rotated.token, "token-alice");
  const send = (token: string) => fetch(`${base}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ session_id: "x", hook_event_name: "SessionStart" }) }).then((r) => r.status);
  assert.equal(await send("token-alice"), 401);
  assert.equal(await send(rotated.token), 200);
  assert.equal(await send("made-up"), 401);
});

test("AI reviews are capped per person, and the operator isn't", { timeout: 60_000 }, async () => {
  const { base, sql } = await start({ MODEL_API_KEY: "test-key", MODEL_API_BASE: "http://127.0.0.1:9", POLICY_MAX_REVIEWS_PER_DAY: "1" });
  await seed(base);
  const stamp = new Date().toISOString();
  sql.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json) VALUES ('r1',?,?,'llm','{}','{}','[]')").run(`${ALICE}.s1`, stamp);
  const r = await fetch(`${base}/api/sessions/${ALICE}.s1/attribute`, { method: "POST", headers: { "content-type": "application/json", ...as(ALICE) }, body: "{}" });
  assert.equal(r.status, 429);
  assert.match(((await r.json()) as { error: string }).error, /today's 1 AI reviews/);
});

test("in live mode, only the operator can move money", { timeout: 60_000 }, async () => {
  const { base } = await start({ PAYPAL_ENV: "live" });
  for (const p of ["/api/funding/subscribe", "/api/funding/topup", "/api/settlements/plan"]) {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...as(BOB) }, body: "{}" });
    assert.equal(r.status, 403, p);
  }
});
