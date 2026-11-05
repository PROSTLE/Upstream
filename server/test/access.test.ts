// Starts the real server and checks who can read what over HTTP: private by default, raw payloads always admin-only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const ADMIN = "admin-test-token";
const INGEST = "ingest-test-token";
const running: ChildProcess[] = [];
after(() => running.forEach((p) => p.kill()));

async function start(access: "private" | "public"): Promise<string> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-access-"));
  const env = {
    ...process.env,
    PORT: String(port), DATABASE_PATH: path.join(dir, "t.db"), DASHBOARD_ACCESS: access, ADMIN_TOKEN: ADMIN, INGEST_TOKEN: INGEST,
    PUBLIC_BASE_URL: `http://localhost:${port}`, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", MODEL_API_KEY: "", MODEL_API_BASE: "https://api.meta.ai",
    TITHE_AMOUNT: "10.00", TITHE_CURRENCY: "USD", TITHE_INTERVAL_UNIT: "MONTH", TITHE_PRODUCT_NAME: "Test tithe", BRAND_NAME: "Upstream",
    POLICY_MAX_PACKAGE_SHARE: "0.6", POLICY_MIN_PAYOUT: "1.00", POLICY_MAX_PAYOUT: "250.00", POLICY_PAYOUT_FEE_RESERVE: "0.02",
    POLICY_RESERVE_DAYS: "60", POLICY_CANCEL_UNCLAIMED_AFTER_DAYS: "7", UPSTREAM_MODEL: "muse-spark-1.3", UPSTREAM_EFFORT: "medium",
    DEPSDEV_API_BASE: "https://api.deps.dev/v3", ECOSYSTEMS_API_BASE: "https://packages.ecosyste.ms/api/v1", METADATA_CACHE_HOURS: "24",
  };
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  running.push(p);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 20_000);
    p.stdout!.on("data", (d) => String(d).includes("server on") && (clearTimeout(t), resolve()));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  // One real hook event, so there is a session and a raw payload to protect.
  const r = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INGEST}` },
    body: JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Edit", cwd: "/home/dev/proj", tool_input: { file_path: "/home/dev/proj/a.ts", new_string: "secret code" } }),
  });
  assert.equal(r.status, 200);
  return base;
}

const status = (base: string, p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers }).then((r) => r.status);

test("private dashboard (the default): operator data needs ADMIN_TOKEN, maintainer pages stay public", { timeout: 60_000 }, async () => {
  const base = await start("private");
  for (const p of ["/api/overview", "/api/sessions", "/api/sessions/s1", "/api/ledger", "/api/settlements", "/api/claims", "/api/packages", "/api/funding", "/api/eval", "/api/audit", "/api/trail?repo=github.com/o/r"]) {
    assert.equal(await status(base, p), 401, `${p} without a token`);
    assert.equal(await status(base, p, { "x-admin-token": ADMIN }), 200, `${p} with the admin token`);
  }
  // The agent's tools read session evidence back with the ingest token, but nothing else.
  assert.equal(await status(base, "/api/sessions", { authorization: `Bearer ${INGEST}` }), 200);
  assert.equal(await status(base, "/api/ledger", { authorization: `Bearer ${INGEST}` }), 401);
  for (const p of ["/api/health", "/api/public/repos", "/api/badge/o/r.svg", "/api/manifest.webmanifest"]) assert.equal(await status(base, p), 200, p);
  const health = (await fetch(base + "/api/health").then((r) => r.json())) as { dashboard_access: string };
  assert.equal(health.dashboard_access, "private");
});

test("public dashboard: reads are open, but raw hook payloads (your own code) still need ADMIN_TOKEN", { timeout: 60_000 }, async () => {
  const base = await start("public");
  assert.equal(await status(base, "/api/sessions/s1"), 200);
  const events = ((await fetch(base + "/api/sessions/s1").then((r) => r.json())) as { events: { id: number }[] }).events;
  assert.equal(await status(base, `/api/sessions/s1/events/${events[0].id}`), 401);
  const raw = (await fetch(base + `/api/sessions/s1/events/${events[0].id}`, { headers: { "x-admin-token": ADMIN } }).then((r) => r.json())) as { payload: { tool_input: { new_string: string } } };
  assert.equal(raw.payload.tool_input.new_string, "secret code");
});
