// The dependency-list method: an equal split of what's declared, stored only with a review, and never used for money.
import "./helpers/env.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, setDbForTests } from "../src/db.ts";
import { ingest } from "../src/evidence/ingest.ts";
import { buildCandidates, type CandidateSet } from "../src/evidence/candidates.ts";
import { manifestComparison } from "../src/attribution/manifest.ts";
import { attributeSession, runsForSession } from "../src/attribution/run.ts";
import { evalReport, labelsAreBlind, saveLabels } from "../src/attribution/eval.ts";

const running: ChildProcess[] = [];
after(() => running.forEach((p) => p.kill()));
before(() => setDbForTests(openDb(":memory:")));

function seed(sessionId: string, deps: Record<string, string>) {
  ingest({ session_id: sessionId, hook_event_name: "SessionStart", cwd: "/p", upstream: { manifest: { root: "/p", files: { "package.json": JSON.stringify({ dependencies: deps }) } }, sent_at: new Date().toISOString() } });
  ingest({ session_id: sessionId, hook_event_name: "PostToolUse", tool_use_id: `${sessionId}-t1`, tool_name: "Write", cwd: "/p", tool_input: { file_path: "/p/a.ts", content: 'import { z } from "zod";\nexport const A = z.string();\n' }, upstream: { sent_at: new Date().toISOString() } });
}

async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("splits equally across every declared package and adds no flags", async () => {
  seed("m1", { zod: "1", "left-pad": "1", react: "1", lodash: "1" });
  const v = manifestComparison(await buildCandidates("m1", { resolve: false }))!;
  assert.equal(v.weights.length, 4);
  assert.ok(v.weights.every((w) => w.weight === 0.25));
  assert.deepEqual(v.flags, []);
  assert.equal(v.unallocated, 0);
  assert.ok(v.weights.some((w) => w.name === "left-pad"), "a package nobody touched is paid: that's the point of comparing");
});

test("with no dependency list there is nothing to compare", () => {
  const set = { session_id: "x", candidates: [{ ecosystem: "npm", name: "zod", in_initial_manifest: false, in_final_manifest: false }], evidence: [], unattributed: [], manifest: {} } as unknown as CandidateSet;
  assert.equal(manifestComparison(set), null);
});

test("it is stored inside a review, never at ingest, so labels saved before the review stay blind", async () => {
  seed("m2", { zod: "1", "left-pad": "1" });
  assert.equal(runsForSession("m2").length, 0, "nothing runs at ingest");
  saveLabels("m2", [{ ecosystem: "npm", package: "zod", label: "meaningful" }, { ecosystem: "npm", package: "left-pad", label: "not_used" }]);
  await new Promise((r) => setTimeout(r, 5));
  const r = await offline(() => attributeSession("m2"));
  assert.ok(r.manifestRunId);
  const methods = runsForSession("m2").map((x) => x.method).sort();
  assert.deepEqual(methods, ["baseline", "manifest"], "no model key in tests, so no llm run");
  assert.equal(labelsAreBlind("m2"), true);
  assert.equal(runsForSession("m2").find((x) => x.method === "manifest")!.is_active, false);
});

test("a session with no dependency list gets no comparison run", async () => {
  ingest({ session_id: "m3", hook_event_name: "PostToolUse", tool_use_id: "m3-t1", tool_name: "Write", cwd: "/p", tool_input: { file_path: "/p/a.ts", content: 'import { z } from "zod";\n' }, upstream: { sent_at: new Date().toISOString() } });
  const r = await offline(() => attributeSession("m3"));
  assert.equal(r.manifestRunId, undefined);
  assert.deepEqual(runsForSession("m3").map((x) => x.method), ["baseline"]);
});

test("the eval scores all three methods, and counts the dependency list only where there is one", async () => {
  const report = evalReport("local");
  assert.equal(report.manifest.sessions, 1, "m2");
  assert.equal(report.blind.manifest.sessions, 1);
  assert.equal(report.manifest.fp, 1, "the equal split pays left-pad, which was labelled not used");
  assert.equal(report.manifest.tp, 1);
  assert.equal(report.manifest.precision, 0.5);
  assert.equal(report.llm.sessions, 0, "no llm run, so nothing to compare for that method");
  // A labelled session with no list is left out of this method's score.
  saveLabels("m3", [{ ecosystem: "npm", package: "zod", label: "meaningful" }]);
  assert.equal(evalReport("local").manifest.sessions, 1);
  assert.equal(evalReport("local").perSession.find((s) => s.session_id === "m3")?.manifest, undefined);
});

test("the active-run route refuses the comparison method", { timeout: 60_000 }, async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-manifest-"));
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, "t.db"), ADMIN_TOKEN: "admin-m", INGEST_TOKEN: "ingest-m", PUBLIC_BASE_URL: `http://localhost:${port}`, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", MODEL_API_KEY: "", DEPSDEV_API_BASE: "http://127.0.0.1:9", ECOSYSTEMS_API_BASE: "http://127.0.0.1:9", NPM_REGISTRY_BASE: "http://127.0.0.1:9" };
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(here, "..", "src", "index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  running.push(p);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 20_000);
    p.stdout!.on("data", (d) => String(d).includes("server on") && (clearTimeout(t), resolve()));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const admin = { "x-admin-token": "admin-m", "content-type": "application/json" };
  const ingestReq = (body: unknown) => fetch(`${base}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ingest-m" }, body: JSON.stringify(body) });
  await ingestReq({ session_id: "s1", hook_event_name: "SessionStart", cwd: "/p", upstream: { manifest: { root: "/p", files: { "package.json": '{"dependencies":{"zod":"1"}}' } } } });
  assert.equal((await fetch(`${base}/api/sessions/s1/attribute`, { method: "POST", headers: admin, body: "{}" })).status, 200);
  const session = (await (await fetch(`${base}/api/sessions/s1`, { headers: admin })).json()) as { runs: { id: string; method: string }[] };
  const manifest = session.runs.find((r) => r.method === "manifest")!;
  const baseline = session.runs.find((r) => r.method === "baseline")!;
  const refuse = await fetch(`${base}/api/sessions/s1/active-run`, { method: "POST", headers: admin, body: JSON.stringify({ run_id: manifest.id }) });
  assert.equal(refuse.status, 400);
  assert.deepEqual(await refuse.json(), { error: "comparison only" });
  assert.equal((await fetch(`${base}/api/sessions/s1/active-run`, { method: "POST", headers: admin, body: JSON.stringify({ run_id: baseline.id }) })).status, 200);
});
