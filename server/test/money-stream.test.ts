// The live stream over real HTTP: who can read it, what comes first, that it stays alive, and that nobody sees anyone else's money.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const ADMIN = "admin-stream-token";
const running: ChildProcess[] = [];
after(() => running.forEach((p) => p.kill()));

async function start(seed: (d: DatabaseSync) => void): Promise<string> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-stream-"));
  const file = path.join(dir, "t.db");
  const boot = (): Promise<ChildProcess> =>
    new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        PORT: String(port), DATABASE_PATH: file, DASHBOARD_ACCESS: "private", ADMIN_TOKEN: ADMIN, INGEST_TOKEN: "ingest-stream",
        PUBLIC_BASE_URL: `http://localhost:${port}`, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", MODEL_API_KEY: "", MODEL_API_BASE: "https://api.meta.ai",
        TITHE_AMOUNT: "10.00", TITHE_CURRENCY: "USD", TITHE_INTERVAL_UNIT: "MONTH", TITHE_PRODUCT_NAME: "Test tithe", BRAND_NAME: "Upstream",
        POLICY_MAX_PACKAGE_SHARE: "0.6", POLICY_MIN_PAYOUT: "1.00", POLICY_MAX_PAYOUT: "250.00", POLICY_PAYOUT_FEE_RESERVE: "0.02",
        POLICY_RESERVE_DAYS: "60", POLICY_CANCEL_UNCLAIMED_AFTER_DAYS: "7", UPSTREAM_MODEL: "muse-spark-1.3", UPSTREAM_EFFORT: "medium",
        DEPSDEV_API_BASE: "https://api.deps.dev/v3", ECOSYSTEMS_API_BASE: "https://packages.ecosyste.ms/api/v1", METADATA_CACHE_HOURS: "24",
      };
      const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], { env, stdio: ["ignore", "pipe", "pipe"] });
      running.push(p);
      const t = setTimeout(() => reject(new Error("server did not start")), 20_000);
      p.stdout!.on("data", (d) => String(d).includes("server on") && (clearTimeout(t), resolve(p)));
      p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    });
  // The first start creates the tables. The seed goes in while no server has the file open, then the server under test starts.
  const first = await boot();
  first.removeAllListeners("exit");
  await new Promise<void>((resolve) => {
    first.on("exit", () => resolve());
    first.kill();
  });
  const d = new DatabaseSync(file);
  seed(d);
  d.close();
  await boot();
  return `http://127.0.0.1:${port}`;
}

const insert = (d: DatabaseSync, userId: string, key: string, label: string) =>
  d.prepare("INSERT INTO money_events(user_id, dedupe_key, type, at, created_at, from_node, to_node, amount_minor, currency, label, trigger_json) VALUES (?,?,'ledger',?,?,'funders','pool',100,'USD',?,'{\"via\":\"api\",\"action\":\"sync\"}')").run(userId, key, "2026-11-01T10:00:00.000Z", "2026-11-01T10:00:00.000Z", label);

/** Reads a stream until `done` says stop, then closes it. */
async function readStream(url: string, headers: Record<string, string>, done: (text: string) => boolean, timeoutMs = 30_000): Promise<{ status: number; type: string; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(url, { headers, signal: ctrl.signal });
  let text = "";
  try {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += decoder.decode(value);
      if (done(text)) break;
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearTimeout(t);
    ctrl.abort();
  }
  return { status: res.status, type: res.headers.get("content-type") ?? "", text };
}

test("the stream: sign-in needed, backlog then hello, a heartbeat, and only your own money", { timeout: 120_000 }, async () => {
  const base = await start((d) => {
    d.prepare("INSERT INTO users(id, created_at) VALUES ('u_other', '2026-01-01')").run();
    insert(d, "local", "a", "First of mine");
    insert(d, "u_other", "x", "Someone else's money");
    insert(d, "local", "b", "Second of mine");
    insert(d, "local", "c", "Third of mine");
  });
  const admin = { "x-admin-token": ADMIN };

  const denied = await fetch(`${base}/api/money/stream`);
  assert.equal(denied.status, 401);
  assert.equal((await fetch(`${base}/api/money/events?after=0`)).status, 401);

  const after1 = await readStream(`${base}/api/money/stream?after=1`, admin, (t) => t.includes("event: hello"));
  assert.equal(after1.status, 200);
  assert.match(after1.type, /^text\/event-stream/);
  assert.ok(after1.text.startsWith("retry: 3000\n\n"), "retry comes first");
  assert.ok(!after1.text.includes("First of mine"), "only what's after the id");
  assert.ok(after1.text.indexOf("Second of mine") < after1.text.indexOf("Third of mine"), "in order");
  assert.ok(after1.text.indexOf("Third of mine") < after1.text.indexOf("event: hello"), "backlog before hello");
  assert.ok(!after1.text.includes("Someone else's money"), "never another person's events");
  assert.match(after1.text, /id: 4\nevent: money\ndata: \{.*"label":"Third of mine".*\}\n\n/);
  const hello = JSON.parse(after1.text.split("event: hello\ndata: ")[1].split("\n")[0]);
  assert.equal(hello.last_id, 4);
  assert.equal(hello.more, false);
  assert.equal(hello.summary.currency, "USD");
  for (const k of ["fundingGross", "fundingFees", "payoutFees", "payoutsSent", "returned", "reserved", "inFlight", "available", "balance", "paidSuccess", "unclaimedAtPaypal"]) assert.equal(typeof hello.summary[k], "number", k);

  const resumed = await readStream(`${base}/api/money/stream`, { ...admin, "last-event-id": "3" }, (t) => t.includes("event: hello"));
  assert.ok(!resumed.text.includes("Second of mine"));
  assert.ok(resumed.text.includes("Third of mine"), "Last-Event-ID resumes after that event");

  const started = Date.now();
  const beat = await readStream(`${base}/api/money/stream?after=4`, admin, (t) => /: ping \d+\n\n/.test(t), 20_000);
  assert.match(beat.text, /: ping \d+\n\n/, "a heartbeat within 20 s");
  assert.ok(Date.now() - started < 20_000);

  const poll = (await (await fetch(`${base}/api/money/events?after=3`, { headers: admin })).json()) as any;
  assert.deepEqual(poll.events.map((e: any) => e.label), ["Third of mine"], "the fallback gives the same events, and only yours");
  assert.equal(poll.last_id, 4);
  assert.equal(poll.summary.currency, "USD");
  const replay = (await (await fetch(`${base}/api/money/events?from=2026-10-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z`, { headers: admin })).json()) as any;
  assert.deepEqual(replay.events.map((e: any) => e.label), ["First of mine", "Second of mine", "Third of mine"]);
});
