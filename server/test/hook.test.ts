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
      const start = runHook(home, { hook_event_name: "SessionStart", session_id: "h1", cwd: proj });
      const map = start.at(-1).upstream.py_import_map;
      assert.ok(map && typeof map === "object", "SessionStart carries the import map");
      assert.ok(Object.values(map).every((d) => Array.isArray(d)), "map values are distribution lists");
      assert.equal(fs.existsSync(marker), false, "project json.py was not imported");

      const stop = runHook(home, { hook_event_name: "Stop", session_id: "h1", cwd: proj });
      assert.equal(stop.at(-1).hook_event_name, "Stop");
      assert.equal(stop.at(-1).upstream.py_import_map, undefined, "unchanged environment is not resent");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
