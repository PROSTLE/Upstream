// The session-file converter must produce what the live hook would have sent, and must never let a person's own file contents through.
import "./helpers/env.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, openDb, setDbForTests } from "../src/db.ts";
import { buildCandidates } from "../src/evidence/candidates.ts";
import { ingest } from "../src/evidence/ingest.ts";
import { responseText } from "../src/evidence/extract.ts";
import { PRIVATE_KEY_BLOCK, REDACTED, SECRET_ASSIGN, SECRET_FLAG, SECRET_HEADER, SECRET_SHAPE, redactSecrets, RECORDED_TOOLS, SECRET_FILE, SOURCE_FILE, chunkEvents, describeStats, isKnownWarning, redactEvent, stripLineNumbers, transcriptToEvents, PYTHON_WARNING } from "../../web/src/transcript.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "transcript-small.jsonl"), "utf8");
const result = transcriptToEvents(fixture);
const tool = (id: string) => result.events.find((e) => e.tool_use_id === id);

before(() => setDbForTests(openDb(":memory:")));

test("patterns stay the same as the live hook's", () => {
  const hook = fs.readFileSync(path.join(here, "..", "..", "hook", "upstream-hook.mjs"), "utf8");
  assert.ok(hook.includes(`const SECRET_FILE = /${SECRET_FILE.source}/i;`), "SECRET_FILE");
  assert.ok(hook.includes(`const SOURCE_FILE = /${SOURCE_FILE.source}/i;`), "SOURCE_FILE");
  const matcher = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "hook", "hooks.json"), "utf8")).hooks.PostToolUse[0].matcher as string;
  assert.equal(RECORDED_TOOLS.source, `^(?:${matcher})$`);
  for (const [name, re] of Object.entries({ SECRET_ASSIGN, SECRET_HEADER, SECRET_FLAG, SECRET_SHAPE, PRIVATE_KEY_BLOCK })) {
    assert.ok(hook.includes(`const ${name} = /${re.source}/${re.flags};`), name);
  }
});

test("secret values in commands and code are blanked, and ordinary code is left alone", () => {
  // Made-up values, shaped like the real thing.
  const key = "AbC123dEf456GhI789jKl012";
  const cases: [string, string][] = [
    [`cat > .env <<'EOF'\nPAYPAL_CLIENT_ID=${key}\nPAYPAL_CLIENT_SECRET=${key}\nMODEL_API_KEY=${key}\nPORT=8787\nEOF`, `PAYPAL_CLIENT_ID=${REDACTED}\nPAYPAL_CLIENT_SECRET=${REDACTED}\nMODEL_API_KEY=${REDACTED}\nPORT=8787`],
    [`export GITHUB_TOKEN="${key}" && npm start`, `export GITHUB_TOKEN="${REDACTED}" && npm start`],
    [`$env:ADMIN_TOKEN = '${key}'; node x.js`, `$env:ADMIN_TOKEN = '${REDACTED}'; node x.js`],
    [`node -e "process.env.MODEL_API_KEY='${key}'"`, `process.env.MODEL_API_KEY='${REDACTED}'`],
    [`curl -H "Authorization: Bearer ${key}" https://api`, `Authorization: Bearer ${REDACTED}"`],
    [`node hook/install.mjs --url https://x --token ${key}`, `--token ${REDACTED}`],
    [`git push https://ghp_${"a1B2".repeat(9)}@github.com/x`, `https://${REDACTED}@github.com`],
    [`-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----`, REDACTED],
    [`const cfg = { "apiKey": "${key}" };`, `"apiKey": "${REDACTED}"`],
  ];
  for (const [input, expected] of cases) {
    const out = redactSecrets(input);
    assert.ok(out.includes(expected), `${input.slice(0, 40)} → ${out}`);
    assert.ok(!out.includes(key) && !out.includes("a1B2a1B2"), `leaked: ${out}`);
  }
  const ordinary = [
    `import { z } from "zod";\nconst token = await getToken();\nconst apiKey = process.env.MODEL_API_KEY;`,
    `const client = new Client({ clientCredentialsAuthCredentials: { oAuthClientId: config.PAYPAL_CLIENT_ID } });`,
    `{ "dependencies": { "js-tokens": "^4.0.0", "zod": "^3.23.8" } }`,
    `npm install zod && npx tsc --noEmit`,
    `"integrity": "sha512-EKN1vKAMcZ8MlYMpaNuRrv4o0e9yhJ8EvVHpakMvc3dq8BS0K6LZLQGDF1D2ySFm"`,
  ];
  for (const text of ordinary) assert.equal(redactSecrets(text), text);
  const event = redactEvent({ hook_event_name: "PostToolUse" as const, tool_name: "Bash", tool_input: { command: `PAYPAL_CLIENT_SECRET=${key} npm run setup:paypal` }, tool_response: { stdout: `secret: ${key}` }, upstream: {} });
  assert.equal((event.tool_input as { command: string }).command, `PAYPAL_CLIENT_SECRET=${REDACTED} npm run setup:paypal`);
  assert.deepEqual(event.tool_response, { omitted: true });
});

test("pairs each tool call with its result and counts what it kept", () => {
  assert.equal(result.sessionId, "sess-fixture");
  assert.equal(result.cwd, "/home/dev/shop");
  assert.equal(result.startedAt, "2026-10-01T10:00:00.000Z");
  assert.equal(result.endedAt, "2026-10-01T10:00:18.000Z", "the torn last line can't be read");
  assert.equal(result.stats.tornLines, 1);
  assert.equal(result.stats.toolCalls, 12);
  assert.equal(result.stats.kept, 9);
  assert.equal(result.stats.skipped, 3, "the failed install, ToolSearch and the call with no result");
  assert.equal(result.stats.lines, 20);
  assert.equal(describeStats(result.stats), "20 lines · 12 tool calls · 9 kept · 1 torn line");
  const post = result.events.filter((e) => e.hook_event_name === "PostToolUse");
  assert.equal(post.length, 9);
  for (const e of post) {
    assert.equal(e.session_id, "sess-fixture");
    assert.equal(e.source, "transcript");
    assert.equal(e.cwd, "/home/dev/shop");
  }
  assert.equal(tool("t-edit")!.upstream.sent_at, "2026-10-01T10:00:12.000Z", "the time of the result line");
  assert.equal(tool("t-failed-install"), undefined, "the hook never sees a tool that failed");
  assert.equal(tool("t-no-result"), undefined);
  assert.equal(tool("t-other-tool"), undefined);
  assert.ok(tool("t-subagent"), "subagent work counts");
});

test("a dependency read keeps its source, with line numbers and the reminder removed", () => {
  assert.equal(tool("t-dep")!.tool_response, "export function object(shape) { return shape; }\nexport function string() { return {}; }");
  assert.equal(stripLineNumbers("     1→a\n     2→b"), "a\nb");
  assert.equal(stripLineNumbers("1\ta\n2\tb"), "a\nb");
});

test("nothing from the person's own files gets through except the code the agent wrote", () => {
  const sent = JSON.stringify(result.events);
  // Marker text appears in an own file's Read, a .env, Bash output and Edit's context lines. The Edit's old_string is the agent's own edit, kept like the live hook.
  assert.equal(tool("t-own")!.tool_response && (tool("t-own")!.tool_response as any).omitted, true);
  assert.deepEqual(tool("t-env")!.tool_response, { redacted: true });
  assert.deepEqual(tool("t-env")!.tool_input, { file_path: "/home/dev/shop/.env", redacted: true });
  assert.doesNotMatch(sent, /PRIVATE_MARKER_SECRET/);
  assert.doesNotMatch(sent, /PRIVATE_MARKER_BASH_OUTPUT/);
  assert.doesNotMatch(sent, /PRIVATE_MARKER_PATCH_CONTEXT/);
  assert.deepEqual(tool("t-edit")!.tool_response, { omitted: true }, "originalFile and structuredPatch are dropped");
  assert.deepEqual(tool("t-bash")!.tool_response, { omitted: true });
  assert.deepEqual(tool("t-subagent")!.tool_response, { omitted: true }, "Grep output can quote own files");
});

test("file_head follows the virtual file, from Write, Edit and an earlier Read", () => {
  assert.equal(tool("t-write")!.upstream.file_head, 'import { z } from "zod";\nexport const User = z.object({ name: z.string() });\n');
  assert.equal(tool("t-write")!.upstream.file_head_truncated, false);
  assert.equal(tool("t-edit")!.upstream.file_head, 'import { z } from "zod";\nexport const User = z.object({ name: z.string(), email: z.string().email() });\n');
  // This Edit shares its result line with Bash, so toolUseResult can't be trusted for it; the base comes from the Read.
  assert.equal(tool("t-edit-own")!.upstream.file_head, 'import { z } from "zod";\nexport const Name = z.string();');
  assert.equal(tool("t-bash")!.upstream.file_head, undefined);
});

test("first 8 KB only, and an unknown base means no head plus a warning", () => {
  const line = (o: object) => JSON.stringify({ sessionId: "s", cwd: "/p", timestamp: "2026-10-01T10:00:00.000Z", ...o });
  const big = "x".repeat(9000);
  const r = transcriptToEvents([
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/p/a.ts", content: big } }, { type: "tool_use", id: "e", name: "Edit", input: { file_path: "/p/b.ts", old_string: "a", new_string: "b" } }, { type: "tool_use", id: "m", name: "MultiEdit", input: { file_path: "/p/a.ts", edits: [{ old_string: "x", new_string: "y", replace_all: true }] } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w", content: "ok" }, { type: "tool_result", tool_use_id: "e", content: "ok" }, { type: "tool_result", tool_use_id: "m", content: "ok" }] } }),
  ].join("\n"));
  const w = r.events.find((e) => e.tool_use_id === "w")!;
  assert.equal(w.upstream.file_head!.length, 8000);
  assert.equal(w.upstream.file_head_truncated, true);
  assert.equal(r.events.find((e) => e.tool_use_id === "e")!.upstream.file_head, undefined);
  assert.equal(r.events.find((e) => e.tool_use_id === "m")!.upstream.file_head!.slice(0, 3), "yyy", "replace_all is respected");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^1 edit changed a file this session never showed in full/);
  assert.ok(isKnownWarning(r.warnings[0]));
  assert.equal(isKnownWarning("<b>click here</b>"), false);
});

test("strings are clipped like the hook's", () => {
  const line = (o: object) => JSON.stringify({ sessionId: "s", cwd: "/p", timestamp: "2026-10-01T10:00:00.000Z", ...o });
  const r = transcriptToEvents([
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/p/a.md", content: "y".repeat(25_000) } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w", content: "ok" }] } }),
  ].join("\n"));
  assert.equal(String(r.events.find((e) => e.tool_use_id === "w")!.tool_input!.content), `${"y".repeat(20_000)}\n…[truncated by upstream]`);
});

test("the dependency list comes first, then the work, then the session end", () => {
  const first = result.events[0];
  assert.equal(first.hook_event_name, "SessionStart");
  assert.deepEqual(first.upstream.manifest, { root: "/home/dev/shop", files: { "package.json": '{"dependencies":{"zod":"^4.0.0","left-pad":"^1.3.0"}}' } });
  const last = result.events.at(-1)!;
  assert.equal(last.hook_event_name, "SessionEnd");
  assert.equal(last.reason, "transcript_import");
  assert.equal(last.upstream.sent_at, "2026-10-01T10:00:18.000Z");
  const given = transcriptToEvents(fixture, { manifests: { "requirements.txt": "requests\n" } });
  assert.deepEqual(Object.keys(given.events[0].upstream.manifest!.files).sort(), ["package.json", "requirements.txt"]);
  assert.equal(transcriptToEvents(fixture.replace("/home/dev/shop/package.json", "/home/dev/shop/sub/package.json").replaceAll('"filePath":"/home/dev/shop/package.json"', '"filePath":"/home/dev/shop/sub/package.json"')).events[0].hook_event_name, "PostToolUse", "only a manifest directly in cwd counts");
});

test("Python files add the import-name warning", () => {
  assert.equal(result.warnings.length, 0);
  const py = fixture.replaceAll("/home/dev/shop/src/schema.ts", "/home/dev/shop/src/schema.py");
  assert.ok(transcriptToEvents(py).warnings.includes(PYTHON_WARNING));
});

test("a file that isn't a session says so instead of inventing one", () => {
  const r = transcriptToEvents('{"hello":"world"}\nnot json\n');
  assert.equal(r.sessionId, null);
  assert.deepEqual(r.events, []);
  assert.equal(r.stats.tornLines, 1);
  assert.match(r.warnings[0], /No session id/);
});

test("the server's own redaction catches a client that didn't redact", () => {
  const raw = { hook_event_name: "PostToolUse" as const, tool_name: "Read", tool_input: { file_path: "/p/src/a.ts" }, tool_response: "secret", upstream: {} };
  assert.deepEqual(redactEvent(raw).tool_response, { omitted: true });
  const dep = { ...raw, tool_input: { file_path: "/p/node_modules/x/a.js" } };
  assert.equal(redactEvent(dep).tool_response, "secret", "dependency source stays");
  const edit = { ...raw, tool_name: "Edit", tool_response: { originalFile: "own code" } };
  assert.deepEqual(redactEvent(edit).tool_response, { omitted: true });
  const secret = { ...raw, tool_name: "Write", tool_input: { file_path: "/p/.env", content: "A=1" }, upstream: { file_head: "A=1", file_head_truncated: false } };
  const r = redactEvent(secret);
  assert.deepEqual(r.tool_input, { file_path: "/p/.env", redacted: true });
  assert.deepEqual(r.upstream, {});
});

test("chunks stay under the limit and keep every event", () => {
  const e = { hook_event_name: "SessionEnd" as const, session_id: "s", source: "transcript" as const, upstream: {}, reason: "x".repeat(100) };
  const chunks = chunkEvents([e, e, e, e, e], 300);
  assert.equal(chunks.flat().length, 5);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(new TextEncoder().encode(JSON.stringify(c)).length < 600);
});

test("the events produce the same evidence the hook's would", async () => {
  for (const e of result.events) ingest(e as any);
  const set = await buildCandidates("sess-fixture", { resolve: false });
  const by = Object.fromEntries(set.candidates.map((c) => [c.name, c]));
  assert.equal(by.zod.status, "used");
  assert.equal(by.zod.counts.import_added, 1, "the Write");
  assert.equal(by.zod.counts.api_usage, 1, "only the Edit that adds a line using it: the other changes one line into one line, the same as live");
  assert.equal(by.zod.counts.source_read, 1);
  assert.equal(by.zod.counts.source_search, 1, "the subagent's Grep");
  assert.equal(by.dayjs.counts.dep_install, 1);
  assert.equal(by["left-pad"].status, "present_only");
  assert.equal(by["left-pad"].in_initial_manifest, true);
  assert.equal(by["does-not-exist-pkg"], undefined, "a failed install is not evidence");
  const session = db().prepare("SELECT source, status, end_reason, started_at FROM sessions WHERE id = 'sess-fixture'").get() as any;
  assert.equal(session.source, "transcript");
  assert.equal(session.status, "closed");
  assert.equal(session.end_reason, "transcript_import");
  assert.equal(session.started_at, "2026-10-01T10:00:00.000Z");
  const excerpt = JSON.parse((db().prepare("SELECT detail_json FROM evidence WHERE kind = 'source_read'").get() as any).detail_json).excerpt;
  assert.match(excerpt, /^export function object/);
});

test("an excerpt comes from the file's contents, not its long path", () => {
  const response = { type: "text", file: { filePath: "/home/someone/projects/shop/node_modules/zod/lib/index.js", content: "export const z = 1;", numLines: 1, startLine: 1, totalLines: 1 } };
  assert.equal(responseText(response), "export const z = 1;");
});
