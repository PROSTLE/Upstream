#!/usr/bin/env node
// Installs the Upstream hooks into a project's .claude/settings.json (or your user settings with --user)
// and writes ~/.upstream/config.json with the server URL and ingest token.
//
//   node hook/install.mjs --url https://your-upstream.onrender.com --token <INGEST_TOKEN> [--project <dir> | --user] [--with-mcp]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const url = opt("url") ?? process.env.UPSTREAM_URL;
const token = opt("token") ?? process.env.UPSTREAM_INGEST_TOKEN;
if (!url || !token) {
  console.error("Usage: node hook/install.mjs --url <UPSTREAM_URL> --token <INGEST_TOKEN> [--project <dir> | --user] [--with-mcp]");
  process.exit(1);
}

const home = path.join(os.homedir(), ".upstream");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ url, token }, null, 2), { mode: 0o600 });

const settingsFile = flag("user")
  ? path.join(os.homedir(), ".claude", "settings.json")
  : path.join(path.resolve(opt("project") ?? process.cwd()), ".claude", "settings.json");
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
let settings = {};
if (fs.existsSync(settingsFile)) settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

const hookScript = path.join(here, "upstream-hook.mjs");
const command = `node "${hookScript}"`;
const entry = (extra = {}) => ({ type: "command", command, ...extra });
const wanted = {
  SessionStart: [{ hooks: [entry({ timeout: 10 })] }],
  PostToolUse: [
    {
      matcher: "Bash|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|mcp__.*",
      hooks: [entry({ async: true })],
    },
  ],
  Stop: [{ hooks: [entry({ async: true })] }],
  SessionEnd: [{ hooks: [entry({ timeout: 5 })] }],
};

settings.hooks ??= {};
for (const [event, groups] of Object.entries(wanted)) {
  const existing = (settings.hooks[event] ?? []).filter(
    (g) => !(g.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("upstream-hook.mjs")),
  );
  settings.hooks[event] = [...existing, ...groups];
}
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
console.log(`Upstream hooks installed in ${settingsFile}`);
console.log(`Events go to ${url} (config in ${path.join(home, "config.json")})`);

if (flag("with-mcp")) {
  const mcpFile = flag("user") ? null : path.join(path.dirname(path.dirname(settingsFile)), ".mcp.json");
  if (!mcpFile) {
    console.log("For user scope, add the MCP server with: claude mcp add upstream -- node " + path.join(here, "..", "mcp", "src", "index.ts"));
  } else {
    let mcp = {};
    if (fs.existsSync(mcpFile)) mcp = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
    mcp.mcpServers ??= {};
    mcp.mcpServers.upstream = {
      command: "node",
      args: [path.join(here, "..", "mcp", "src", "index.ts")],
      env: { UPSTREAM_URL: url },
    };
    fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
    console.log(`Upstream MCP server registered in ${mcpFile} (set UPSTREAM_ADMIN_TOKEN in your environment to allow payout actions).`);
  }
}
