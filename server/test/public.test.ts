import "./helpers/env.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { db, now, openDb, setDbForTests } from "../src/db.ts";
import { badgeSvg, moneyTrail, repoSummary, reposWithMoney } from "../src/public.ts";

before(() => {
  setDbForTests(openDb(":memory:"));
  const d = db();
  d.prepare("INSERT INTO sessions(id, project, started_at, last_event_at, status) VALUES ('s1','shop',?,?,'attributed'), ('s2','blog',?,?,'attributed')").run(now(), now(), now(), now());
  d.prepare("INSERT INTO packages(ecosystem, name, repo) VALUES ('npm','zod','github.com/colinhacks/zod'), ('npm','dayjs','github.com/iamkun/dayjs')").run();
  const run = (zod: number, dayjs: number) => ({
    weights: [
      { ecosystem: "npm", name: "zod", weight: zod, classification: "meaningful", evidence_ids: ["ev_1_0"], rationale: "Schemas for every form.", proposed_weight: 3 },
      { ecosystem: "npm", name: "dayjs", weight: dayjs, classification: "supporting", evidence_ids: ["ev_2_0"], rationale: "", proposed_weight: 1 },
    ],
    unallocated: 0,
    flags: [],
  });
  const cands = JSON.stringify({ evidence: [{ id: "ev_1_0", kind: "import_added", strength: "strong" }, { id: "ev_2_0", kind: "docs_fetch", strength: "weak" }] });
  d.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('r1','s1',?,'llm',?,?,'[]',1)").run(now(), cands, JSON.stringify(run(0.6, 0.4)));
  d.prepare("INSERT INTO attribution_runs(id, session_id, created_at, method, candidates_json, validated_json, flags_json, is_active) VALUES ('r2','s2',?,'llm',?,?,'[]',1)").run(now(), cands, JSON.stringify(run(1, 0)));
  d.prepare(
    `INSERT INTO allocations(id, settlement_id, repo, ecosystem, package, amount_minor, currency, status, target, session_ids_json, created_at, updated_at)
     VALUES ('a1','stl1','github.com/iamkun/dayjs','npm','dayjs',412,'USD','reserved','reserve','["s1"]',?,?),
            ('a2','stl1','github.com/colinhacks/zod','npm','zod',900,'USD','paid','payout','["s1","s2"]',?,?),
            ('a3','stl2','github.com/colinhacks/zod','npm','zod',50,'USD','planned','payout','["s2"]',?,?)`,
  ).run(now(), now(), now(), now(), now(), now());
  d.prepare("INSERT INTO claims(id, repo, method, github_login, paypal_receiver, status, created_at, verified_at) VALUES ('c1','github.com/colinhacks/zod','github_admin','colinhacks','m@example.com','verified',?,?)").run(now(), now());
});

test("repo summary counts relying sessions and money by state, never planned drafts", () => {
  const zod = repoSummary("github.com/colinhacks/zod")!;
  assert.equal(zod.sessions_relied, 2);
  assert.equal(zod.paid, "9.00");
  assert.equal(zod.held, "0.00");
  assert.deepEqual(zod.claim, { status: "verified", github_login: "colinhacks", verified_at: zod.claim.verified_at, proof: { method: "github_admin", permission: null } });
  const dayjs = repoSummary("github.com/iamkun/dayjs")!;
  assert.equal(dayjs.sessions_relied, 1, "a zero weight in s2 is not reliance");
  assert.equal(dayjs.held, "4.12");
  assert.equal(dayjs.claim.status, "none");
  assert.equal(repoSummary("github.com/nobody/nothing"), undefined);
});

test("repos with money put the biggest unclaimed hold first", () => {
  assert.deepEqual(reposWithMoney().map((r) => r.repo), ["github.com/iamkun/dayjs", "github.com/colinhacks/zod"]);
});

test("money trail links allocations to sessions, weights, rationale and cited evidence", () => {
  const t = moneyTrail("github.com/colinhacks/zod");
  assert.deepEqual(t.allocations.map((a) => a.id), ["a2"], "planned draft allocations are left out");
  const s1 = t.sessions.find((s) => s.id === "s1")!;
  assert.equal(s1.project, "shop");
  assert.equal(s1.weights[0].rationale, "Schemas for every form.");
  assert.deepEqual(s1.weights[0].evidence, [{ id: "ev_1_0", kind: "import_added", strength: "strong" }]);
});

test("badge says what is waiting, what was paid, or that nothing is known, and escapes text", () => {
  assert.match(badgeSvg(repoSummary("github.com/iamkun/dayjs")), /\$4\.12 waiting · claim it/);
  assert.match(badgeSvg(repoSummary("github.com/colinhacks/zod")), /\$9\.00 paid by agents/);
  const none = badgeSvg(undefined);
  assert.match(none, /not yet used by agents/);
  assert.match(none, /^<svg [^>]*role="img"/);
  assert.doesNotMatch(none, /<script/);
});
