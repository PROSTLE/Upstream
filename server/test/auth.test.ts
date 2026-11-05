// Starts the real server and checks what a GitHub session can and can't do. The GitHub exchange itself needs real keys.
import "./helpers/env.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const { openSession, sealSession } = await import("../src/auth.ts");
const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const ADMIN = "admin-test-token";
const running: ChildProcess[] = [];
after(() => running.forEach((p) => p.kill()));

async function start(): Promise<{ base: string; file: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upstream-auth-")), "t.db");
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: file, DASHBOARD_ACCESS: "private", ADMIN_TOKEN: ADMIN, INGEST_TOKEN: "ingest-test-token",
      OPERATOR_GITHUB_LOGINS: "Octo-Operator", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "", PUBLIC_BASE_URL: `http://localhost:${port}`,
      PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "",
    },
  });
  running.push(p);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 20_000);
    p.stdout!.on("data", (d) => String(d).includes("server on") && (clearTimeout(t), resolve()));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const sql = new DatabaseSync(file);
  sql.prepare("UPDATE users SET login = 'octo-operator', github_id = '1' WHERE id = 'local'").run();
  sql.prepare("INSERT INTO users(id, github_id, login, ingest_token, created_at) VALUES ('u_member','2','someone-else','t',?)").run(new Date().toISOString());
  sql.close();
  return { base: `http://127.0.0.1:${port}`, file };
}

const asUser = (value: string) => ({ cookie: `upstream_session=${value}` });

test("sealed sessions reject tampering, the wrong secret and expiry", () => {
  const good = sealSession("u_1", "secret");
  assert.equal(openSession(good, "secret"), "u_1");
  assert.equal(openSession(good, "other-secret"), null);
  const [body, mac] = good.split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "local", exp: 9999999999 })).toString("base64url");
  assert.equal(openSession(`${forged}.${mac}`, "secret"), null, "changed body");
  assert.equal(openSession(`${body}.`, "secret"), null, "missing signature");
  assert.equal(openSession(sealSession("u_1", "secret", 1), "secret"), null, "expired");
});

test("signing in opens your own space, and only a valid session does", { timeout: 60_000 }, async () => {
  const { base } = await start();
  const me = (headers = {}) => fetch(`${base}/api/auth/me`, { headers }).then((r) => r.json()) as Promise<{ user: { role: string; login: string } | null; github_login_available: boolean }>;
  const status = (p: string, headers = {}) => fetch(base + p, { headers }).then((r) => r.status);

  assert.equal((await me()).user, null);
  assert.equal((await me()).github_login_available, false);
  assert.equal(await status("/api/overview"), 401, "signed out sees nothing");

  const operator = asUser(sealSession("local", ADMIN));
  assert.equal((await me(operator)).user?.role, "operator");
  assert.equal(await status("/api/overview", operator), 200);

  const member = asUser(sealSession("u_member", ADMIN));
  assert.deepEqual([(await me(member)).user?.role, (await me(member)).user?.login], ["member", "someone-else"]);
  assert.equal(await status("/api/overview", member), 200, "a member reaches their own space");

  const forged = asUser(sealSession("local", "wrong-secret"));
  assert.equal((await me(forged)).user, null);
  assert.equal(await status("/api/overview", forged), 401);

  const ghost = asUser(sealSession("u_never_signed_up", ADMIN));
  assert.equal((await me(ghost)).user, null, "a signed cookie for nobody real is nobody");
  assert.equal(await status("/api/overview", ghost), 401);

  const write = (origin?: string) =>
    fetch(`${base}/api/funding/sync`, { method: "POST", headers: { ...operator, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}" }).then((r) => r.status);
  assert.equal(await write("https://evil.example"), 401, "another site can't act as a signed-in person");
  assert.equal(await write(base), 400, "same site reaches the handler (no subscription yet)");

  const start2 = await fetch(`${base}/api/auth/github/start`, { redirect: "manual" });
  assert.match(start2.headers.get("location") ?? "", /^\/\?auth_error=/, "no keys: explains instead of failing");

  const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: operator });
  assert.match(out.headers.get("set-cookie") ?? "", /upstream_session=;/);
});

test("an operator removed from OPERATOR_GITHUB_LOGINS loses the session immediately", { timeout: 60_000 }, async () => {
  const { base, file } = await start();
  const value = asUser(sealSession("local", ADMIN));
  assert.equal((await fetch(`${base}/api/overview`, { headers: value })).status, 200);
  const sql = new DatabaseSync(file);
  sql.prepare("UPDATE users SET login = 'no-longer-listed' WHERE id = 'local'").run();
  sql.close();
  assert.equal((await fetch(`${base}/api/overview`, { headers: value })).status, 401);
});
