#!/usr/bin/env node
// Builds the /check page's sample from one real Claude Code session you have picked:
//   node scripts/make-sample.ts <transcript.jsonl> <out.json> [--manifest <package.json>] [--allow]
// It converts the session like the browser does, replaces absolute paths (home folder -> ~, project folder -> its name),
// and lists anything that looks like a secret. Read the output before you commit it. Never commit the transcript itself.
// --manifest adds a dependency list, like the check page's optional file: a monorepo's root usually declares nothing itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeStats, transcriptToEvents } from "../web/src/transcript.ts";

const args = process.argv.slice(2);
const flag = args.indexOf("--manifest");
const manifestFile = flag >= 0 ? args[flag + 1] : undefined;
const [input, output] = args.filter((a, i) => !a.startsWith("--") && (flag < 0 || i !== flag + 1));
if (!input || !output) {
  console.error("Usage: node scripts/make-sample.ts <transcript.jsonl> <out.json> [--manifest <package.json>] [--allow]");
  process.exit(1);
}

const converted = transcriptToEvents(fs.readFileSync(input, "utf8"), manifestFile ? { manifests: { [path.basename(manifestFile)]: fs.readFileSync(manifestFile, "utf8") } } : {});
if (!converted.sessionId) {
  console.error(`${input} doesn't look like a Claude Code session file.`);
  process.exit(1);
}

/** Every spelling a path can have in the file: as given, with forward slashes, with escaped backslashes, and with a lower-case drive letter. */
function spellings(p: string): string[] {
  const forward = p.replace(/\\/g, "/");
  const all = [p, forward, p.replace(/\\/g, "\\\\")];
  return [...new Set(all.flatMap((s) => [s, s.replace(/^[A-Za-z]:/, (m) => m.toLowerCase()), s.replace(/^[A-Za-z]:/, (m) => m.toUpperCase())]))].sort((a, b) => b.length - a.length);
}

const cwd = converted.cwd ?? "";
const project = cwd ? path.win32.basename(cwd.replace(/\//g, "\\")) : "";
const replacements: [string, string][] = [
  ...(cwd ? spellings(cwd).map((s): [string, string] => [s, project]) : []),
  ...spellings(os.homedir()).map((s): [string, string] => [s, "~"]),
];

function scrub<T>(value: T): T {
  if (typeof value === "string") return replacements.reduce((text, [from, to]) => text.split(from).join(to), value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrub(v)])) as T;
  return value;
}

const events = scrub(converted.events);
const body = JSON.stringify({ file_name: "a-real-session-building-upstream.jsonl", stats: converted.stats, warnings: converted.warnings, events }, null, 0);

// Tokens this project and its tools use, plus the common shapes. A hit stops the script: look at it before publishing anything.
const SECRET_SHAPES: [string, RegExp][] = [
  ["Upstream ingest token", /\bupt_[\w-]{20,}/],
  ["Upstream claim token", /\bupc_[0-9a-f]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}/],
  ["API key", /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{20,}/],
  ["bearer token", /[Bb]earer\s+[A-Za-z0-9._-]{20,}/],
  ["PayPal or other client secret", /(?:CLIENT_SECRET|API_KEY|ADMIN_TOKEN|INGEST_TOKEN|PASSWORD|SECRET)\s*[=:]\s*["']?[A-Za-z0-9._\-+/]{8,}/],
  ["email address", /\b(?!noreply@)[\w.+-]+@(?!example\.com\b)[\w-]+\.[a-z]{2,}\b/i],
];
const hits = SECRET_SHAPES.flatMap(([label, re]) => {
  const found = body.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? [];
  return found.length ? [{ label, count: found.length, example: `${found[0].slice(0, 6)}…` }] : [];
});

const leftovers = replacements.filter(([from]) => from.length > 3 && body.includes(from)).map(([from]) => from);
console.log(`${describeStats(converted.stats)}`);
console.log(`${events.length} events, ${(body.length / 1e6).toFixed(2)} MB, from ${converted.startedAt} to ${converted.endedAt}`);
for (const w of converted.warnings) console.log(`Warning: ${w}`);
const commands = events.flatMap((e) => (e.tool_name === "Bash" && typeof e.tool_input?.command === "string" ? [e.tool_input.command.split("\n")[0].slice(0, 100)] : []));
console.log(`\nCommands in this sample (${commands.length}), read them before publishing:`);
for (const c of commands.slice(0, 200)) console.log(`  ${c}`);

if (hits.length || leftovers.length) {
  console.error("\nNOT written. This session has text that must not be published:");
  for (const h of hits) console.error(`  ${h.label}: ${h.count} (${h.example})`);
  for (const l of leftovers) console.error(`  path still present: ${l}`);
  console.error("Pick another session, or pass --allow only after you've checked every one of these.");
  if (!process.argv.includes("--allow")) process.exit(1);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, body);
console.log(`\nWrote ${output}. Read it before you commit it.`);
