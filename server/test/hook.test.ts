import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hook", "upstream-hook.mjs");

function hasPython(): boolean {
  for (const py of ["python3", "python"]) {
    try {
      execFileSync(py, ["-c", "import importlib.metadata"], { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {}
  }
  return false;
}

/** Runs the real hook script with an isolated home directory and returns what it spooled. */
function runHook(home: string, payload: object): any[] {
  execFileSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, USERPROFILE: home, UPSTREAM_URL: "", UPSTREAM_INGEST_TOKEN: "" },
    timeout: 90_000,
  });
  const spool = path.join(home, ".upstream", "spool.jsonl");
  const lines = fs.existsSync(spool) ? fs.readFileSync(spool, "utf8").trim().split("\n").filter(Boolean) : [];
  return lines.map((l) => JSON.parse(l));
}

test(
  "hook maps python imports without running project files, and Stop resends only after the environment changes",
  { skip: hasPython() ? false : "no python interpreter on PATH", timeout: 180_000 },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-hook-"));
    const home = path.join(root, "home");
    const proj = path.join(root, "proj");
    fs.mkdirSync(home);
    fs.mkdirSync(proj);
    const marker = path.join(root, "shadow-ran");
    // A project module that shadows the stdlib must never execute inside the hook.
    fs.writeFileSync(path.join(proj, "json.py"), `open(${JSON.stringify(marker)}, "w").write("ran")\n`);
    try {
      // Cold cache: SessionStart has an 8 s budget, so on a slow or busy machine the map may only
      // arrive with the first Stop (which has 60 s). Either way the session gets it exactly once.
      runHook(home, { hook_event_name: "SessionStart", session_id: "h1", cwd: proj });
      const afterStop = runHook(home, { hook_event_name: "Stop", session_id: "h1", cwd: proj });
      const maps = afterStop.map((e) => e.upstream.py_import_map).filter(Boolean);
      assert.equal(maps.length, 1, "the import map is sent once, by SessionStart or else the first Stop");
      assert.ok(Object.values(maps[0]).every((d) => Array.isArray(d)), "map values are distribution lists");
      assert.equal(fs.existsSync(marker), false, "project json.py was not imported");

      const stop = runHook(home, { hook_event_name: "Stop", session_id: "h1", cwd: proj });
      assert.equal(stop.at(-1).hook_event_name, "Stop");
      assert.equal(stop.at(-1).upstream.py_import_map, undefined, "unchanged environment is not resent");

      // Warm cache (what install.mjs sets up): a new session's SessionStart carries the map itself.
      const next = runHook(home, { hook_event_name: "SessionStart", session_id: "h2", cwd: proj });
      assert.ok(next.at(-1).upstream.py_import_map, "SessionStart carries the map once the cache is warm");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("spool flush skips a torn line, sends the rest once and keeps nothing behind", async () => {
  const { createServer } = await import("node:http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-spool-"));
  const dir = path.join(home, ".upstream");
  fs.mkdirSync(dir);
  const spool = path.join(dir, "spool.jsonl");
  const queued = [{ hook_event_name: "Stop", session_id: "s1" }, { hook_event_name: "Stop", session_id: "s2" }];
  // The second line is cut short, as after a crash mid-append; it used to block every later flush.
  fs.writeFileSync(spool, `${JSON.stringify(queued[0])}\n{"hook_event_name":"Sto\n${JSON.stringify(queued[1])}\n`);
  const received: any[] = [];
  const { gunzipSync } = await import("node:zlib");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // The hook gzips what it sends, the way Express on the real server inflates it.
      assert.equal(req.headers["content-encoding"], "gzip");
      const b = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8"));
      received.push(...(Array.isArray(b) ? b : [b]));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [hook],
        { env: { ...process.env, HOME: home, USERPROFILE: home, UPSTREAM_URL: `http://127.0.0.1:${port}`, UPSTREAM_INGEST_TOKEN: "t" }, timeout: 30_000 },
        (err) => (err ? reject(err) : resolve()),
      ).stdin!.end(JSON.stringify({ hook_event_name: "Stop", session_id: "s3", cwd: home })),
    );
    assert.deepEqual(received.map((e) => e.session_id).sort(), ["s1", "s2", "s3"]);
    assert.equal(fs.existsSync(spool) ? fs.readFileSync(spool, "utf8") : "", "", "spool is empty after a successful flush");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".sending")), [], "no claimed file is left behind");
  } finally {
    server.close();
  }
});
