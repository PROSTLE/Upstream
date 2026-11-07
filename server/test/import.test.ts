// Importing past sessions: nothing already stored is stored twice, no review runs on its own, and blind labelling works.
import "./helpers/env.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db, openDb, setDbForTests } from "../src/db.ts";
import { ingest } from "../src/evidence/ingest.ts";
import { cleanTranscriptEvents, importTranscript } from "../src/evidence/import.ts";
import { labelsAreBlind, saveLabels } from "../src/attribution/eval.ts";
import { attributeSession } from "../src/attribution/run.ts";
import { transcriptToEvents } from "../../web/src/transcript.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "transcript-small.jsonl"), "utf8");
const events = () => transcriptToEvents(fixture).events;
/** The same session under another id. Tool ids get a suffix too: they are unique in real life, and dedupe relies on that. */
const eventsFor = (sessionId: string) => events().map((e) => ({ ...e, session_id: sessionId, ...(e.tool_use_id ? { tool_use_id: `${e.tool_use_id}-${sessionId}` } : {}) }));
const running: ChildProcess[] = [];

before(() => setDbForTests(openDb(":memory:")));
after(() => running.forEach((p) => p.kill()));

test("importing the same file twice stores nothing the second time", () => {
  const first = importTranscript(cleanTranscriptEvents(events()), "local");
  assert.equal(first.session_id, "sess-fixture");
  assert.equal(first.stored, events().length);
  assert.ok(first.evidence > 0);
  const again = importTranscript(cleanTranscriptEvents(events()), "local");
  assert.deepEqual(again, { session_id: "sess-fixture", stored: 0, evidence: 0 });
  const runs = db().prepare("SELECT COUNT(*) AS n FROM attribution_runs").get() as { n: number };
  assert.equal(runs.n, 0, "an import never runs a review");
});

test("a session the hook already captured gains nothing, and keeps its own end", () => {
  const list = eventsFor("hooked");
  for (const e of list.filter((x) => x.hook_event_name === "PostToolUse")) {
    const { source: _source, ...live } = e;
    ingest(live as any, "local");
  }
  const count = () => (db().prepare("SELECT COUNT(*) AS n FROM hook_events WHERE session_id = 'hooked'").get() as { n: number }).n;
  const stored = count();
  assert.ok(stored > 0);
  const r = importTranscript(cleanTranscriptEvents(list), "local");
  assert.equal(r.stored, 0);
  assert.equal(count(), stored);
  const s = db().prepare("SELECT source, end_reason FROM sessions WHERE id = 'hooked'").get() as any;
  assert.equal(s.source, "hook");
  assert.equal(s.end_reason, null);
});

test("each person's copy is theirs: the same file imports separately for someone else", () => {
  db().prepare("INSERT OR IGNORE INTO users(id, created_at) VALUES ('u_bob', ?)").run(new Date().toISOString());
  const r = importTranscript(cleanTranscriptEvents(events()), "u_bob");
  assert.equal(r.session_id, "u_bob.sess-fixture");
  assert.equal(r.stored, events().length);
  assert.equal((db().prepare("SELECT user_id FROM sessions WHERE id = ?").get(r.session_id) as { user_id: string }).user_id, "u_bob");
});

test("the server redacts and whitelists again, whatever the client sends", () => {
  const [clean] = cleanTranscriptEvents([
    { hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "t", tool_name: "Read", tool_input: { file_path: "/p/src/own.ts" }, tool_response: "OWN CODE", evil: true, upstream: { sent_at: "not a date", py_import_map: { a: ["b"] } } },
  ]);
  assert.deepEqual(clean.tool_response, { omitted: true });
  assert.equal((clean as any).evil, undefined);
  assert.deepEqual(clean.upstream, {});
  const [start] = cleanTranscriptEvents([{ hook_event_name: "SessionStart", session_id: "s1", cwd: "/p", upstream: { manifest: { root: "/p", files: { "package.json": "{}", "../../etc/passwd": "x", "notes.txt": "y" } } } }]);
  assert.deepEqual(Object.keys(start.upstream!.manifest!.files), ["package.json"]);
  assert.throws(() => cleanTranscriptEvents([]), /no events/);
  assert.throws(() => cleanTranscriptEvents("x"), /no events/);
  assert.throws(() => cleanTranscriptEvents([{ hook_event_name: "PostToolUse", session_id: "../bad id" }]), /valid session id/);
  assert.throws(() => cleanTranscriptEvents([{ hook_event_name: "Stop", session_id: "s1" }]), /isn't from a session file/);
  assert.throws(() => cleanTranscriptEvents([{ hook_event_name: "SessionEnd", session_id: "s1" }, { hook_event_name: "SessionEnd", session_id: "s2" }]), /one session/);
});

test("labelling an imported session and then reviewing it counts as blind", async () => {
  const imported = importTranscript(cleanTranscriptEvents(eventsFor("blind-1")), "local");
  assert.ok(imported.evidence > 0);
  saveLabels("blind-1", [{ ecosystem: "npm", package: "zod", label: "meaningful" }]);
  assert.equal(labelsAreBlind("blind-1"), true);
  // Keep the labels strictly earlier than the review's timestamp.
  await new Promise((r) => setTimeout(r, 5));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  try {
    await attributeSession("blind-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(labelsAreBlind("blind-1"), true, "a review after labelling leaves them blind");
});

test("over HTTP: importing needs sign-in, and a 5 MB upload is accepted while the global limit is 4 MB", { timeout: 60_000 }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-import-"));
  const env = {
    ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, "t.db"), ADMIN_TOKEN: "admin-import", INGEST_TOKEN: "ingest-import",
    PUBLIC_BASE_URL: `http://localhost:${port}`, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", MODEL_API_KEY: "",
  };
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(here, "..", "src", "index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  running.push(p);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 20_000);
    p.stdout!.on("data", (d) => String(d).includes("server on") && (clearTimeout(t), resolve()));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/sessions/import`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const admin = { "x-admin-token": "admin-import" };
  assert.equal((await post({ events: events() })).status, 401);

  const big = { ...events().at(-1)!, session_id: "big" };
  const filler = "x".repeat(19_000);
  const many = Array.from({ length: 280 }, (_, i) => ({ hook_event_name: "PostToolUse", session_id: "big", tool_use_id: `t${i}`, tool_name: "Write", cwd: "/p", source: "transcript", tool_input: { file_path: `/p/${i}.md`, content: filler }, upstream: { sent_at: "2026-10-01T10:00:00.000Z" } }));
  const ok = await post({ file_name: "big.jsonl", events: [...many, big] }, admin);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { stored: number }).stored, 281);

  const tooBig = await post({ events: [{ hook_event_name: "SessionEnd", session_id: "x", padding: "y".repeat(10_500_000) }] }, admin);
  assert.equal(tooBig.status, 413);
  assert.match(((await tooBig.json()) as { error: string }).error, /10mb limit/);

  const list = (await (await fetch(`${base}/api/sessions`, { headers: admin })).json()) as { id: string; source: string }[];
  assert.equal(list.find((s) => s.id === "big")!.source, "transcript");
});
