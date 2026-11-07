// Inviting a maintainer: real numbers from this person's own records, a form a person submits, and a note that they did it.
import "./helpers/env.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { db, now, openDb, setDbForTests } from "../src/db.ts";
import { inviteDetails, recordInvite } from "../src/public.ts";
import { inviteBody, issueUrl } from "../../web/src/invite-text.ts";

const candidates = {
  candidates: [
    { ecosystem: "npm", name: "drizzle-orm", usage_lines: 41, counts: { import_added: 3, source_read: 2, docs_mcp: 1 }, evidence_ids: ["e1"] },
    { ecosystem: "npm", name: "unrelated", usage_lines: 99, counts: { import_added: 9 }, evidence_ids: ["e2"] },
  ],
};

before(() => {
  setDbForTests(openDb(":memory:"));
  const d = db();
  d.prepare("INSERT INTO users(id, created_at) VALUES ('u_other', ?)").run(now());
  for (const id of ["s1", "s2"]) {
    d.prepare("INSERT INTO sessions(id, started_at, last_event_at, status) VALUES (?, ?, ?, 'attributed')").run(id, now(), now());
    d.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES (?, ?, ?, 'llm', ?, '{\"weights\":[],\"unallocated\":1,\"flags\":[]}', '[]', 1)").run(`r-${id}`, id, now(), JSON.stringify(candidates));
  }
  const alloc = d.prepare("INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, expires_at, updated_at, user_id) VALUES (?,?,?,?,?,?,'USD',?,'reserve',?,?,?,?,?)");
  alloc.run("a1", "stl1", "github.com/drizzle-team/drizzle-orm", "npm", "drizzle-orm", 210, "reserved", '["s1"]', now(), "2027-01-20T00:00:00.000Z", now(), "local");
  alloc.run("a2", "stl2", "github.com/drizzle-team/drizzle-orm", "npm", "drizzle-orm", 150, "reserved", '["s2"]', now(), "2027-01-05T00:00:00.000Z", now(), "local");
  alloc.run("a3", "stl3", "github.com/drizzle-team/drizzle-orm", "npm", "drizzle-orm", 999, "paid", '["s1"]', now(), null, now(), "local");
  alloc.run("a4", "stl4", "github.com/drizzle-team/drizzle-orm", "npm", "drizzle-orm", 777, "reserved", "[]", now(), "2026-12-01T00:00:00.000Z", now(), "u_other");
});

const details = () => {
  const d = inviteDetails("github.com/drizzle-team/drizzle-orm", "local");
  if ("error" in d) throw new Error(d.error);
  return d;
};

test("details come from this person's held money and the runs behind it", () => {
  const d = details();
  assert.equal(d.held, "3.60", "only reserved money, only theirs");
  assert.equal(d.currency, "USD");
  assert.equal(d.expires_at, "2027-01-05T00:00:00.000Z", "the earliest hold");
  assert.equal(d.sessions, 2);
  assert.deepEqual(d.packages, ["drizzle-orm"]);
  assert.equal(d.usage_lines, 82, "both sessions, and not another package's lines");
  assert.deepEqual(d.evidence, { import_added: 6, source_read: 4, docs_mcp: 2 });
  assert.match(d.claim_url, /\/claim\?repo=drizzle-team\/drizzle-orm$/);
  assert.equal(d.invited, null);
});

test("no held money or a verified maintainer means nothing to invite to", () => {
  assert.deepEqual(inviteDetails("github.com/nobody/nothing", "local"), { error: "You have no money held for this repository." });
  db().prepare("INSERT INTO claims(id, repo, method, paypal_receiver, status, created_at, verified_at) VALUES ('c1','github.com/verified/repo','github_admin','m@example.com','verified',?,?)").run(now(), now());
  db().prepare("INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, updated_at, user_id) VALUES ('a9','stl1','github.com/verified/repo','npm','v',100,'USD','reserved','reserve','[]',?,?,'local')").run(now(), now());
  assert.deepEqual(inviteDetails("github.com/verified/repo", "local"), { error: "This repository already has a verified maintainer." });
});

test("the message states real numbers, offers the claim link and the way out, and fits GitHub's address limit", () => {
  const body = inviteBody(details(), "Upstream");
  assert.match(body, /^In the last 2 coding sessions, AI agents relied on drizzle-orm: 82 lines written against its API, 4 source files read, 2 docs lookups\. \$3\.60 is held for its maintainers through Upstream and PayPal\./);
  assert.match(body, /Claim it \(sign in with GitHub, then add a PayPal account for payouts\): http:\/\/localhost:8787\/claim\?repo=drizzle-team\/drizzle-orm/);
  assert.match(body, /Unclaimed money returns to the funder's pool on January 5, 2027\./);
  assert.match(body, /If you don't want funding this way, close this issue\. Nothing else will be posted\.$/);
  const url = issueUrl("github.com/drizzle-team/drizzle-orm", "Open-source funding is waiting for drizzle-team/drizzle-orm", body);
  assert.ok(url.startsWith("https://github.com/drizzle-team/drizzle-orm/issues/new?title="));
  assert.ok(url.length < 6000);
  assert.equal(new URL(url).searchParams.get("body"), body, "the body survives the address intact");

  const quiet = inviteBody({ ...details(), usage_lines: 0, evidence: {}, sessions: 1, expires_at: null }, "Upstream");
  assert.match(quiet, /^In the last 1 coding session, AI agents relied on drizzle-orm\. /, "a number that's zero isn't mentioned");
  assert.doesNotMatch(quiet, /Unclaimed money returns/);
});

test("sending is only remembered, per person, and the latest one counts", () => {
  assert.throws(() => recordInvite("github.com/drizzle-team/drizzle-orm", "local", "carrier-pigeon"), /Unknown invite channel/);
  recordInvite("github.com/drizzle-team/drizzle-orm", "local", "github_issue");
  assert.equal(details().invited!.channel, "github_issue");
  recordInvite("github.com/drizzle-team/drizzle-orm", "local", "copied_text");
  assert.equal(details().invited!.channel, "copied_text");
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n, 1);
  const theirs = inviteDetails("github.com/drizzle-team/drizzle-orm", "u_other");
  assert.ok(!("error" in theirs) && theirs.invited === null, "someone else's invite is theirs alone");
});
