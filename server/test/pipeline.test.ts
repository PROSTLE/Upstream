import "./helpers/env.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb, setDbForTests } from "../src/db.ts";
import { ingest } from "../src/evidence/ingest.ts";
import { buildCandidates } from "../src/evidence/candidates.ts";
import { setPayPalFetch } from "../src/paypal/client.ts";
import { verifyWebhook } from "../src/paypal/webhooks.ts";

before(() => setDbForTests(openDb(":memory:")));

test("hook events -> evidence -> candidates separates used, mapped and merely present", async () => {
  const sid = "pipe-1";
  ingest({
    session_id: sid,
    hook_event_name: "SessionStart",
    cwd: "/p",
    upstream: {
      sent_at: "2026-10-11T10:00:00.000Z",
      manifest: { root: "/p", files: { "package.json": '{"dependencies":{"react":"^19","dayjs":"^1"}}', "requirements.txt": "requests==2.32\n" } },
      py_import_map: { requests: ["requests"], yaml: ["PyYAML"] },
    },
  });
  const write = {
    session_id: sid,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_use_id: "tu_1",
    cwd: "/p",
    tool_input: { file_path: "/p/app.py", content: "import os\nimport requests\nimport yaml\nr = requests.get(u)\ncfg = yaml.safe_load(r.text)\n" },
    upstream: { sent_at: "2026-10-11T10:01:00.000Z" },
  };
  assert.equal(ingest(write).stored, true);
  assert.equal(ingest(write).stored, false, "same tool_use_id is stored once");
  ingest({
    session_id: sid,
    hook_event_name: "Stop",
    cwd: "/p",
    upstream: { sent_at: "2026-10-11T10:02:00.000Z", manifest: { root: "/p", files: { "package.json": '{"dependencies":{"react":"^19","dayjs":"^1","zod":"^4"}}', "requirements.txt": "requests==2.32\n" } } },
  });

  const set = await buildCandidates(sid, { resolve: false });
  const by = Object.fromEntries(set.candidates.map((c) => [`${c.ecosystem}:${c.name}`, c]));
  assert.equal(by["pypi:requests"].status, "used");
  assert.equal(by["pypi:pyyaml"].status, "used", "import name yaml maps to the PyYAML distribution");
  assert.equal(set.evidence.find((e) => e.package === "pyyaml")?.link, "import_map");
  assert.equal(by["npm:react"].status, "present_only");
  assert.equal(by["npm:zod"].added_in_session, true, "manifest diff between SessionStart and Stop");
  assert.ok(set.unattributed.some((u) => /"os"/.test(u.reason)), "stdlib import is not attributed to any package");
});

test("code rewritten after reading a library's source becomes evidence, but unrelated or imported code doesn't", async () => {
  const read = (sid: string, file: string, excerpt: string, id: string) =>
    ingest({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: id, cwd: "/p", tool_input: { file_path: file }, tool_response: { file: { content: excerpt.padEnd(60, " ") } } });
  const write = (sid: string, content: string, id: string) =>
    ingest({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: id, cwd: "/p", tool_input: { file_path: "/p/src/x.ts", content } });
  const kinds = async (sid: string, pkg: string) => (await buildCandidates(sid, { resolve: false })).candidates.find((c) => c.name === pkg)?.counts ?? {};

  read("re-1", "/p/node_modules/lodash/debounce.js", "function debounce(func, wait) { var timerId; }", "r1");
  write("re-1", "export function debounce(fn: Function, ms: number) { let t: any; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }", "w1");
  const candidates = await buildCandidates("re-1", { resolve: false });
  assert.equal(candidates.candidates.find((c) => c.name === "lodash")?.counts.logic_reused, 1);
  assert.deepEqual(candidates.evidence.find((e) => e.kind === "logic_reused")?.detail.shared_names, ["debounce"]);

  read("re-2", "/p/node_modules/lodash/debounce.js", "function debounce(func, wait) { }", "r2");
  write("re-2", "export function greetVisitor(who: string) { return who; }", "w2");
  assert.equal((await kinds("re-2", "lodash")).logic_reused, undefined, "unrelated code");

  read("re-3", "/p/node_modules/lodash/debounce.js", "function debounce(func, wait) { }", "r3");
  write("re-3", "import _ from 'lodash';\nexport const debounce = (f: any) => _.debounce(f, 10);", "w3");
  assert.equal((await kinds("re-3", "lodash")).logic_reused, undefined, "imported, so it's ordinary use");

  write("re-4", "export function debounce(fn: Function) { return fn; }", "w4a");
  read("re-4", "/p/node_modules/lodash/debounce.js", "function debounce(func, wait) { }", "r4");
  assert.equal((await kinds("re-4", "lodash")).logic_reused, undefined, "written before the source was read");

  read("re-5", "/p/node_modules/lodash/index.js", "function parse(x) { } function format(y) { }", "r5");
  write("re-5", "export function parse(s: string) { return s; }\nexport function format(s: string) { return s; }", "w5");
  assert.equal((await kinds("re-5", "lodash")).logic_reused, undefined, "generic names aren't a signal");
});

test("a brand-new npm package resolves from the registry before the indexes know it", async () => {
  const { resolvePackage } = await import("../src/resolve/index.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org/brand-new-pkg/latest")) return new Response(JSON.stringify({ repository: { url: "git+https://github.com/Some-One/Brand-New-Pkg.git" }, homepage: "https://example.org/pkg" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const p = await resolvePackage("npm", "brand-new-pkg");
    assert.equal(p.repo, "github.com/some-one/brand-new-pkg");
    assert.equal(p.repo_provenance, "npm-registry:repository");
    assert.equal(p.homepage, "https://example.org/pkg");
    assert.equal(p.resolve_error, null);
  } finally {
    globalThis.fetch = real;
  }
});

test("a failed metadata lookup keeps a package's known repo, so held money stays payable", async () => {
  const { resolvePackage } = await import("../src/resolve/index.ts");
  const { db } = await import("../src/db.ts");
  db().prepare("INSERT INTO packages(ecosystem, name, repo, repo_provenance, resolved_at) VALUES ('npm','known-pkg','github.com/o/known-pkg','npm-registry:repository','2020-01-01T00:00:00.000Z')").run();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  try {
    const p = await resolvePackage("npm", "known-pkg", true);
    assert.equal(p.repo, "github.com/o/known-pkg");
    assert.equal(p.repo_provenance, "npm-registry:repository");
    assert.ok(p.resolve_error, "the failure is still recorded");
  } finally {
    globalThis.fetch = real;
  }
});

test("webhook verification sends PayPal the raw event body byte-for-byte", async () => {
  let sent = "";
  setPayPalFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    sent = String(init?.body);
    return new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
  }) as typeof fetch);
  const raw = '{"id":"WH-EVT-1",   "event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{"b":1,"a":2.50}}';
  const status = await verifyWebhook(
    {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
      "paypal-transmission-id": "tid",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-10-11T10:00:00Z",
    },
    raw,
  );
  assert.equal(status, "SUCCESS");
  assert.ok(sent.endsWith(`,"webhook_event":${raw}}`), "raw body spliced in unchanged");
  const parsed = JSON.parse(sent);
  assert.equal(parsed.webhook_id, "WH-TEST-123");
  assert.equal(parsed.transmission_id, "tid");
  assert.equal(await verifyWebhook({}, raw), "FAILURE", "missing PayPal headers never verify");
});
