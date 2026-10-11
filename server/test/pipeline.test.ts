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
