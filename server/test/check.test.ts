// The public check page: no sign-in, nothing private comes back, limits hold, nothing counts in public totals, and the data goes after 24 hours.
import "./helpers/env.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db, isCheckUser, now, openDb, setDbForTests } from "../src/db.ts";
import { aiDecision, checkView, cleanupExpiredChecks, hashIp, startCheck } from "../src/check.ts";
import { publicActivity, repoSummary, reposWithMoney } from "../src/public.ts";
import { planSettlement } from "../src/settlement.ts";
import { transcriptToEvents } from "../../web/src/transcript.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "transcript-small.jsonl"), "utf8");
const converted = transcriptToEvents(fixture);
const running: ChildProcess[] = [];
const realFetch = globalThis.fetch;

before(() => {
  setDbForTests(openDb(":memory:"));
  // Registry lookups aren't what's being tested.
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  running.forEach((p) => p.kill());
});

const start = async () => {
  const c = startCheck({ events: converted.events, fileName: "session.jsonl", stats: converted.stats, warnings: [...converted.warnings, "<b>injected</b>"], ipHash: hashIp("203.0.113.9") });
  await c.done;
  return c.id;
};

test("limits: the AI review pauses at either limit, and is off without a model key", () => {
  const base = { llmOn: true, aiToday: 0, fromAddress: 0, maxPerDay: 100, maxPerIpPerHour: 5 };
  assert.equal(aiDecision(base), "running");
  assert.equal(aiDecision({ ...base, aiToday: 99 }), "running");
  assert.equal(aiDecision({ ...base, aiToday: 100 }), "paused");
  assert.equal(aiDecision({ ...base, fromAddress: 4 }), "running");
  assert.equal(aiDecision({ ...base, fromAddress: 5 }), "paused");
  assert.equal(aiDecision({ ...base, llmOn: false }), "off");
});

test("a check runs the deterministic methods under a throwaway user and shows only counts, kinds and names", async () => {
  const id = await start();
  const v = checkView(id)!;
  assert.equal(v.status, "done");
  assert.equal(v.ai_state, "off", "no model key in tests");
  assert.deepEqual(v.runs.map((r) => r.method), ["baseline", "manifest"]);
  assert.equal(v.declared, 2);
  assert.equal(v.merely_present, 1, "left-pad");
  assert.equal(v.relied_on, 1, "zod");
  assert.deepEqual(v.warnings, [], "text a client invents is not displayed");
  assert.equal(v.stats.kept, 9);
  assert.equal(v.file_name, "session.jsonl");
  const zod = v.candidates.find((c) => c.name === "zod")!;
  assert.equal(zod.status, "used");
  assert.equal(zod.counts.import_added, 1);
  const manifest = v.runs.find((r) => r.method === "manifest")!;
  assert.deepEqual(manifest.weights.map((w) => w.weight), [0.5, 0.5]);

  const row = db().prepare("SELECT user_id, ip_hash, expires_at, created_at FROM public_checks WHERE id = ?").get(id) as any;
  assert.ok(isCheckUser(row.user_id));
  assert.notEqual(row.ip_hash, "203.0.113.9");
  assert.equal(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime() > 23.9 * 3600 * 1000, true);

  const sent = JSON.stringify(v);
  for (const secret of ["z.object", "import {", "PRIVATE_MARKER", "npm install", "new_string", "file_head", "rationale", "excerpt", "/home/dev"]) {
    assert.ok(!sent.includes(secret), `the response must not contain ${secret}`);
  }
});

test("a check never counts in public totals, repo pages or money lists", async () => {
  db().prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod') ON CONFLICT DO UPDATE SET repo = excluded.repo").run();
  const quiet = publicActivity();
  const id = await start();
  const userId = (db().prepare("SELECT user_id FROM public_checks WHERE id = ?").get(id) as { user_id: string }).user_id;
  // Even a fully attributed check, with an active run and an allocation, stays invisible.
  const sid = (db().prepare("SELECT session_id FROM public_checks WHERE id = ?").get(id) as { session_id: string }).session_id;
  const validated = { weights: [{ ecosystem: "npm", name: "zod", weight: 0.4, classification: "meaningful", evidence_ids: ["e"], rationale: "", proposed_weight: 1 }], unallocated: 0.6, flags: [] };
  db().prepare("UPDATE sessions SET status = 'attributed' WHERE id = ?").run(sid);
  db().prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('rchk', ?, ?, 'llm', '{}', ?, '[]', 1)").run(sid, now(), JSON.stringify(validated));
  db().prepare("INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, updated_at, user_id) VALUES ('achk','s','github.com/colinhacks/zod','npm','zod',500,'USD','reserved','reserve','[]',?,?,?)").run(now(), now(), userId);
  assert.deepEqual(publicActivity(), quiet);
  const repo = repoSummary("github.com/colinhacks/zod")!;
  assert.equal(repo.sessions_relied, 0);
  assert.equal(repo.held, "0.00");
  assert.deepEqual(reposWithMoney(), []);
  db().prepare("DELETE FROM allocations WHERE id = 'achk'").run();
  assert.throws(() => planSettlement(userId), /can't be paid out/);
});

test("after 24 hours everything is gone, in an order the foreign keys accept", async () => {
  const id = await start();
  const { user_id: userId, session_id: sid } = db().prepare("SELECT user_id, session_id FROM public_checks WHERE id = ?").get(id) as { user_id: string; session_id: string };
  db().prepare("INSERT INTO labels(session_id, ecosystem, package, label, updated_at) VALUES (?, 'npm', 'zod', 'meaningful', ?)").run(sid, now());
  assert.ok(checkView(id));
  assert.equal(cleanupExpiredChecks(), 0, "nothing is due yet");

  // Past its expiry the page is gone at once, even before cleanup runs.
  db().prepare("UPDATE public_checks SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
  assert.equal(checkView(id), undefined);
  const others = (db().prepare("SELECT COUNT(*) AS n FROM public_checks WHERE id != ? AND expires_at > ?").get(id, now()) as { n: number }).n;
  assert.equal(cleanupExpiredChecks(), 1);
  for (const [table, where] of [["evidence", "session_id"], ["attribution_runs", "session_id"], ["labels", "session_id"], ["hook_events", "session_id"], ["sessions", "id"]] as const) {
    assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} = ?`).get(sid) as { n: number }).n, 0, table);
  }
  assert.equal(db().prepare("SELECT 1 FROM users WHERE id = ?").get(userId), undefined);
  assert.equal(db().prepare("SELECT 1 FROM public_checks WHERE id = ?").get(id), undefined);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM public_checks").get() as { n: number }).n, others, "other checks are untouched");
});

/** Starts the real server on a fresh database, with no PayPal, AI or registry access, and returns its address. */
async function startServer(extra: Record<string, string> = {}): Promise<string> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-check-"));
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, "t.db"), ADMIN_TOKEN: "admin-c", INGEST_TOKEN: "ingest-c", DASHBOARD_ACCESS: "private", PUBLIC_BASE_URL: `http://localhost:${port}`, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", MODEL_API_KEY: "", PUBLIC_CHECK_MAX_PER_IP_PER_HOUR: "1", DEPSDEV_API_BASE: "http://127.0.0.1:9", ECOSYSTEMS_API_BASE: "http://127.0.0.1:9", NPM_REGISTRY_BASE: "http://127.0.0.1:9", ...extra };
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(here, "..", "src", "index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  running.push(p);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 20_000);
    p.stdout!.on("data", (d) => String(d).includes("server on") && (clearTimeout(t), resolve()));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  return `http://127.0.0.1:${port}`;
}

test("behind Render's proxies, each visitor has their own limit, and a forged address changes nothing", { timeout: 90_000 }, async () => {
  const base = await startServer({ TRUST_PROXY_HOPS: "3" });
  // What Render forwarded on Nov 7, 2026: the visitor, a Cloudflare edge that varies, then Render's load balancer. A local proxy connects.
  const lb = "10.194.213.217";
  const post = (chain: string) => realFetch(`${base}/api/check`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": chain }, body: JSON.stringify({ events: converted.events, file_name: "s.jsonl" }) });
  // Limit 1 per hour, hard stop at 4.
  for (let i = 1; i <= 4; i++) assert.equal((await post(`198.51.100.1, 104.23.160.${i}, ${lb}`)).status, 200);
  assert.equal((await post(`198.51.100.1, 172.69.178.208, ${lb}`)).status, 429, "the same visitor through another Cloudflare edge is still the same visitor");
  assert.equal((await post(`198.51.100.2, 172.70.219.98, ${lb}`)).status, 200, "another visitor has their own limit");
  assert.equal((await post(`198.51.100.2, 198.51.100.1, 104.23.160.9, ${lb}`)).status, 429, "an address put in front by the visitor is ignored");
});

test("a gzipped upload is accepted, and the size limit applies to what it unpacks to", { timeout: 60_000 }, async () => {
  const { gzipSync } = await import("node:zlib");
  const base = await startServer();
  const post = (body: string) => realFetch(`${base}/api/check`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(body) });
  const ok = await post(JSON.stringify({ events: converted.events, file_name: "s.jsonl" }));
  assert.equal(ok.status, 200);
  assert.match(((await ok.json()) as { id: string }).id, /^chk_/);
  // About 12 MB of JSON squeezes into a few KB of gzip; it must still be refused for its real size.
  const huge = JSON.stringify({ events: converted.events, file_name: "s.jsonl", padding: "x".repeat(12_000_000) });
  assert.equal((await post(huge)).status, 413);
});

test("over HTTP, signed out: the sample flow works, an unknown id is a 404, and the hard limit turns an address away", { timeout: 90_000 }, async () => {
  const base = await startServer();
  const post = () => realFetch(`${base}/api/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: converted.events, file_name: "s.jsonl", stats: converted.stats, warnings: converted.warnings }) });
  const first = await post();
  assert.equal(first.status, 200);
  const { id } = (await first.json()) as { id: string };
  assert.match(id, /^chk_/);

  let view: any = {};
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    view = await (await realFetch(`${base}/api/check/${id}`)).json();
    if (view.status !== "running") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(view.status, "done");
  assert.deepEqual(view.runs.map((r: any) => r.method), ["baseline", "manifest"]);

  const unknown = await realFetch(`${base}/api/check/chk_nope`);
  assert.equal(unknown.status, 404);
  assert.match(((await unknown.json()) as { error: string }).error, /24 hours/);

  // Limit 1 per hour, hard stop at 4: the next three still run, without the AI; the one after is refused unread.
  for (let i = 0; i < 3; i++) assert.equal((await post()).status, 200);
  const refused = await post();
  assert.equal(refused.status, 429);
  assert.match(((await refused.json()) as { error: string }).error, /Too many checks/);

  // Private data stays private: a check's session isn't reachable through the dashboard API.
  const status = await realFetch(`${base}/api/sessions`, { headers: { "x-admin-token": "admin-c" } });
  assert.deepEqual(await status.json(), [], "the operator's sessions don't include checks");
  const activity = (await (await realFetch(`${base}/api/public/activity`)).json()) as { sessions_reviewed: number };
  assert.equal(activity.sessions_reviewed, 0);
  assert.equal((await realFetch(`${base}/api/check`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 429);
});
