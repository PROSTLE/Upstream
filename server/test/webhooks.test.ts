// When the server's address changes, the webhook moves with it instead of leaving a dead one behind at PayPal.
// PayPal is replaced by an in-process stand-in that exists only in tests.
import "./helpers/env.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.PUBLIC_BASE_URL = "https://new.example.com";
process.env.PAYPAL_WEBHOOK_ID = "";

const { openDb, setDbForTests, getSetting, setSetting } = await import("../src/db.ts");
const { setPayPalFetch } = await import("../src/paypal/client.ts");
const { ensureWebhook, SUBSCRIBED_EVENTS } = await import("../src/paypal/webhooks.ts");

const NEW_URL = "https://new.example.com/api/paypal/webhook";
const allEvents = SUBSCRIBED_EVENTS.map((name) => ({ name }));
let hooks: { id: string; url: string; event_types: { name: string }[] }[] = [];
let writes: { method: string; path: string; body: any }[] = [];

function fakePayPal(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (init?.method === "GET") return json(200, { webhooks: hooks });
    writes.push({ method: String(init?.method), path: url.pathname, body: JSON.parse(String(init?.body)) });
    return init?.method === "POST" ? json(201, { id: "WH-CREATED" }) : json(200, {});
  }) as typeof fetch;
}

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  setPayPalFetch(fakePayPal());
  hooks = [];
  writes = [];
});

test("a known webhook moves to the new address and keeps its id", async () => {
  setSetting("paypal.webhook_id", "WH-OLD");
  hooks = [{ id: "WH-OLD", url: "https://old.example.com/api/paypal/webhook", event_types: allEvents }];
  assert.deepEqual(await ensureWebhook(), { id: "WH-OLD", created: false });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PATCH");
  assert.equal(writes[0].path, "/v1/notifications/webhooks/WH-OLD");
  assert.deepEqual(writes[0].body.find((op: any) => op.path === "/url"), { op: "replace", path: "/url", value: NEW_URL });
  assert.equal(getSetting("paypal.webhook_id"), "WH-OLD");
});

test("someone else's webhook on the same app is left alone", async () => {
  hooks = [{ id: "WH-OTHER", url: "https://other.example.com/hook", event_types: allEvents }];
  assert.deepEqual(await ensureWebhook(), { id: "WH-CREATED", created: true });
  assert.deepEqual(writes.map((w) => w.method), ["POST"]);
  assert.equal(getSetting("paypal.webhook_id"), "WH-CREATED");
});

test("a webhook already at this address changes nothing", async () => {
  setSetting("paypal.webhook_id", "WH-OLD");
  hooks = [{ id: "WH-OLD", url: NEW_URL, event_types: allEvents }];
  assert.deepEqual(await ensureWebhook(), { id: "WH-OLD", created: false });
  assert.equal(writes.length, 0);
});
