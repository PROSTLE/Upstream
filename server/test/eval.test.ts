import "./helpers/env.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { db, openDb, setDbForTests } from "../src/db.ts";
import { ingest } from "../src/evidence/ingest.ts";
import { evalReport, labelsAreBlind, saveLabels } from "../src/attribution/eval.ts";

before(() => setDbForTests(openDb(":memory:")));

/** Stores a validated run at a given time, the way attribution/run.ts does. */
function addRun(sessionId: string, method: "llm" | "baseline", createdAt: string, weights: Record<string, number>) {
  const validated = {
    weights: Object.entries(weights).map(([name, weight]) => ({ ecosystem: "npm", name, weight, evidence_ids: [], classification: weight > 0 ? "meaningful" : "not_used" })),
    unallocated: 0,
    flags: [],
  };
  db()
    .prepare(
      `INSERT INTO attribution_runs(id, session_id, created_at, method, model, candidates_json, raw_output_json, validated_json, flags_json, usage_json, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
    )
    .run(`${sessionId}-${method}`, sessionId, createdAt, method, method === "llm" ? "test-model" : null, "{}", null, JSON.stringify(validated), "[]", null);
}

const later = () => new Date(Date.now() + 60_000).toISOString();

test("labels saved before attribution are blind; changing one afterwards makes the session not blind", () => {
  ingest({ session_id: "ev-1", hook_event_name: "SessionStart", cwd: "/p", upstream: { sent_at: new Date().toISOString() } });
  assert.equal(labelsAreBlind("ev-1"), false, "no labels yet");

  const labels = [
    { ecosystem: "npm", package: "zod", label: "meaningful" },
    { ecosystem: "npm", package: "react", label: "not_used" },
  ];
  saveLabels("ev-1", labels);
  assert.equal(labelsAreBlind("ev-1"), true, "labelled before any run");

  addRun("ev-1", "baseline", later(), { zod: 0.2, react: 0 });
  addRun("ev-1", "llm", later(), { zod: 1, react: 0 });
  assert.equal(labelsAreBlind("ev-1"), true, "runs created after the labels");

  saveLabels("ev-1", labels);
  assert.equal(labelsAreBlind("ev-1"), true, "re-saving unchanged labels keeps their timestamps");

  const report = evalReport("local");
  assert.equal(report.llm.sessions, 1);
  assert.equal(report.blind.llm.sessions, 1, "blind session is in the blind subset");
  assert.equal(report.blind.llm.tp, 1);
  assert.equal(report.blind.llm.tn, 1);
});

test("a changed label after attribution is not blind, and a cleared label is removed", () => {
  ingest({ session_id: "ev-2", hook_event_name: "SessionStart", cwd: "/p", upstream: { sent_at: new Date().toISOString() } });
  addRun("ev-2", "baseline", new Date(Date.now() - 60_000).toISOString(), { dayjs: 1 });
  addRun("ev-2", "llm", new Date(Date.now() - 60_000).toISOString(), { dayjs: 1, lodash: 0 });

  saveLabels("ev-2", [
    { ecosystem: "npm", package: "dayjs", label: "meaningful" },
    { ecosystem: "npm", package: "lodash", label: "incidental" },
  ]);
  assert.equal(labelsAreBlind("ev-2"), false, "labelled after attribution ran");

  saveLabels("ev-2", [{ ecosystem: "npm", package: "dayjs", label: "meaningful" }]);
  const rows = db().prepare("SELECT package FROM labels WHERE session_id = 'ev-2'").all() as { package: string }[];
  assert.deepEqual(rows.map((r) => r.package), ["dayjs"], "lodash label was cleared");

  const report = evalReport("local");
  assert.equal(report.llm.sessions, 2, "both sessions count overall");
  assert.equal(report.blind.llm.sessions, 1, "only the first session is blind");
  assert.equal(report.perSession.find((s) => s.session_id === "ev-2")?.blind, false);
});
