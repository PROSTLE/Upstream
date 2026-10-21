#!/usr/bin/env node
// Upstream evidence collector for Claude Code hooks (PostToolUse, SessionStart, Stop, SessionEnd).
// Reads the hook JSON from stdin, adds a little local context, and forwards it to your Upstream server.
// It never blocks or fails the agent: every error is swallowed and the event is spooled for retry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const HOME = path.join(os.homedir(), ".upstream");
const SPOOL = path.join(HOME, "spool.jsonl");
const MAX_FIELD = 20_000;
const FILE_HEAD = 8_000;
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|\.npmrc|\.pypirc)$/i;
const SOURCE_FILE = /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro|py|pyi)$/i;

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8"));
  } catch {}
  // Installed as a Claude Code plugin, the URL and token arrive as plugin options (userConfig server_url / ingest_token).
  const opt = (k) => process.env[`CLAUDE_PLUGIN_OPTION_${k}`] || undefined;
  return {
    url: process.env.UPSTREAM_URL ?? opt("SERVER_URL") ?? file.url,
    token: process.env.UPSTREAM_INGEST_TOKEN ?? opt("INGEST_TOKEN") ?? file.token,
  };
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function clipStrings(value, depth = 0) {
  if (typeof value === "string") return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) + "\n…[truncated by upstream]" : value;
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, depth + 1)]));
}

function manifestSnapshot(cwd) {
  const files = {};
  try {
    for (const name of fs.readdirSync(cwd)) {
      if (name === "package.json" || name === "pyproject.toml" || /^requirements.*\.(txt|in)$/i.test(name)) {
        const p = path.join(cwd, name);
        if (fs.statSync(p).size < 300_000) files[name] = fs.readFileSync(p, "utf8");
      }
    }
  } catch {}
  return { root: cwd, files };
}

// `python -c` puts the cwd first on sys.path; drop it before importing anything so a project file
// named json.py (or similar) never runs inside the hook.
const PY_PRELUDE = "import sys; sys.path[:] = [p for p in sys.path if p]; import json, os; ";
// Cheap fingerprint of the environment: interpreter + mtime of every sys.path directory.
// Installing or removing a distribution adds or removes entries in site-packages, which changes its mtime.
const PY_PROBE = PY_PRELUDE + "print(json.dumps([sys.executable] + [[p, os.stat(p).st_mtime_ns] for p in sys.path if os.path.isdir(p)]))";
// importlib.metadata.packages_distributions(): top-level import name -> distribution names.
// It reads every installed distribution's metadata, so it takes seconds on large environments.
const PY_MAP = PY_PRELUDE + "import importlib.metadata as m; print(json.dumps(m.packages_distributions()))";
const PY_CACHE = path.join(HOME, "py-import-map");

function pythonCandidates(cwd) {
  const venvs = [".venv", "venv", "env"].flatMap((v) => [path.join(cwd, v, "Scripts", "python.exe"), path.join(cwd, v, "bin", "python")]);
  return [...venvs.filter((p) => fs.existsSync(p)), "python3", "python"];
}

/** Returns { key, map } for the project's interpreter, from cache when the environment is unchanged. */
function pythonImportMap(cwd, computeTimeoutMs) {
  for (const py of pythonCandidates(cwd)) {
    let key;
    try {
      key = execFileSync(py, ["-c", PY_PROBE], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"], cwd }).toString("utf8").trim();
    } catch {
      continue; // not installed (or a store alias stub): try the next candidate
    }
    const file = path.join(PY_CACHE, `${createHash("sha256").update(JSON.parse(key)[0]).digest("hex").slice(0, 16)}.json`);
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cached.key === key) return { key, map: cached.map };
    } catch {}
    try {
      const out = execFileSync(py, ["-c", PY_MAP], { timeout: computeTimeoutMs, stdio: ["ignore", "pipe", "ignore"], cwd });
      const map = JSON.parse(out.toString("utf8"));
      try {
        fs.mkdirSync(PY_CACHE, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ key, map }));
      } catch {}
      return { key, map };
    } catch {
      return undefined; // this interpreter exists but the map timed out; a later Stop event retries
    }
  }
  return undefined;
}

// Which environment fingerprint was last sent for each session, so Stop only resends after a change.
const PY_SENT = path.join(HOME, "py-import-map-sent.json");
function sentKey(sessionId, key) {
  let sent = {};
  try {
    sent = JSON.parse(fs.readFileSync(PY_SENT, "utf8"));
  } catch {}
  if (key === undefined) return sent[sessionId];
  sent[sessionId] = key;
  const recent = Object.fromEntries(Object.entries(sent).slice(-50));
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(PY_SENT, JSON.stringify(recent));
  } catch {}
}

function redact(payload) {
  const input = payload.tool_input ?? {};
  const file = input.file_path ?? input.notebook_path ?? "";
  if (file && SECRET_FILE.test(file)) {
    payload.tool_input = { file_path: file, redacted: true };
    payload.tool_response = { redacted: true };
  }
  if (payload.tool_name === "Read" && !/node_modules|site-packages|dist-packages/.test(file)) {
    // Only dependency sources need their contents; your own files are reduced to their path.
    payload.tool_response = { omitted: true };
  }
  return payload;
}

async function post(cfg, body) {
  const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}`);
}

function spool(payload) {
  spoolLines([payload]);
}

async function flushSpool(cfg) {
  // Async hooks run in parallel: take the spool by renaming it, so two processes never send or rewrite the same
  // lines, and an event appended meanwhile lands in a fresh spool instead of being overwritten.
  const claimed = `${SPOOL}.${process.pid}.${Date.now()}.sending`;
  try {
    // A hook killed mid-send leaves its claimed file behind; after 10 minutes it goes back into the spool.
    for (const f of fs.readdirSync(HOME)) {
      const p = path.join(HOME, f);
      if (f.startsWith("spool.jsonl.") && f.endsWith(".sending") && Date.now() - fs.statSync(p).mtimeMs > 600_000) {
        fs.appendFileSync(SPOOL, fs.readFileSync(p, "utf8"));
        fs.rmSync(p, { force: true });
      }
    }
  } catch {}
  try {
    fs.renameSync(SPOOL, claimed);
  } catch {
    return; // nothing spooled, or another hook process is flushing it
  }
  let lines = [];
  try {
    lines = fs.readFileSync(claimed, "utf8").split("\n").filter(Boolean);
  } catch {}
  // A line cut short by a crash is dropped instead of blocking every later flush.
  const events = lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  let sent = 0;
  try {
    for (; sent < events.length; sent += 200) await post(cfg, events.slice(sent, sent + 200));
  } finally {
    const rest = events.slice(sent);
    if (rest.length) spoolLines(rest);
    try {
      fs.rmSync(claimed, { force: true });
    } catch {}
  }
}

function spoolLines(payloads) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(SPOOL, payloads.map((p) => JSON.stringify(p) + "\n").join(""));
  } catch {}
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const cwd = payload.cwd ?? process.cwd();
  payload.upstream = { sent_at: new Date().toISOString() };

  if (payload.hook_event_name === "SessionStart") {
    payload.upstream.manifest = manifestSnapshot(cwd);
    // SessionStart runs synchronously with a 10 s budget (see install.mjs); a cache hit costs one probe.
    const py = pythonImportMap(cwd, 8000);
    if (py) {
      payload.upstream.py_import_map = py.map;
      sentKey(payload.session_id, py.key);
    }
  } else if (payload.hook_event_name === "Stop") {
    payload.upstream.manifest = manifestSnapshot(cwd);
    // Stop is async, so it can afford a slow first computation and picks up packages installed mid-session.
    const py = pythonImportMap(cwd, 60_000);
    if (py && sentKey(payload.session_id) !== py.key) {
      payload.upstream.py_import_map = py.map;
      sentKey(payload.session_id, py.key);
    }
  } else if (payload.hook_event_name === "PostToolUse") {
    redact(payload);
    const file = payload.tool_input?.file_path;
    if (["Edit", "MultiEdit", "Write"].includes(payload.tool_name) && file && SOURCE_FILE.test(file) && !payload.tool_input.redacted) {
      try {
        const head = fs.readFileSync(file, "utf8");
        payload.upstream.file_head = head.slice(0, FILE_HEAD);
        payload.upstream.file_head_truncated = head.length > FILE_HEAD;
      } catch {}
    }
  }
  payload = clipStrings(payload);

  const cfg = loadConfig();
  if (!cfg.url || !cfg.token) return spool(payload);
  try {
    await post(cfg, payload);
    await flushSpool(cfg).catch(() => {});
  } catch {
    spool(payload);
  }
}

// `--warm-python <dir>` (run by install.mjs) fills the import-map cache ahead of time, so even the
// first SessionStart on a machine gets a cache hit instead of racing its 8 s budget.
if (process.argv[2] === "--warm-python") {
  const py = pythonImportMap(path.resolve(process.argv[3] ?? process.cwd()), 120_000);
  console.log(py ? `Python import map cached (${Object.keys(py.map).length} import names)` : "No Python interpreter found; skipped");
  process.exit(0);
}

// End by letting the event loop drain, not with process.exit(): on Windows, exiting while fetch's sockets
// are still closing trips a libuv assertion (UV_HANDLE_CLOSING) and the hook reports a crash exit code.
main().catch(() => {}).finally(() => {
  process.exitCode = 0;
});
