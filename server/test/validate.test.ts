import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/attribution/validate.ts";
import { baselineProposal } from "../src/attribution/baseline.ts";
import type { CandidateSet } from "../src/evidence/candidates.ts";
import { splitByWeights, toMinor, fromMinor } from "../src/money.ts";

const set: CandidateSet = {
  session_id: "s1",
  manifest: {},
  unattributed: [{ id: "ev_9_0", kind: "web_search", reason: "x", detail: {} }],
  evidence: [
    { id: "ev_1_0", kind: "import_added", strength: "strong", at: "", ecosystem: "npm", package: "zod", link: "direct", detail: { usage_lines: 4 } },
    { id: "ev_2_0", kind: "source_read", strength: "moderate", at: "", ecosystem: "npm", package: "lodash", link: "direct", detail: {} },
    { id: "ev_3_0", kind: "import_added", strength: "strong", at: "", ecosystem: "npm", package: "dayjs", link: "direct", detail: { usage_lines: 1 } },
  ],
  candidates: [
    { ecosystem: "npm", name: "zod", status: "used", repo: "github.com/colinhacks/zod", repo_provenance: null, in_initial_manifest: false, in_final_manifest: true, added_in_session: true, counts: { import_added: 1 }, usage_lines: 4, evidence_ids: ["ev_1_0"] },
    { ecosystem: "npm", name: "lodash", status: "used", repo: null, repo_provenance: null, in_initial_manifest: true, in_final_manifest: true, added_in_session: false, counts: { source_read: 1 }, usage_lines: 0, evidence_ids: ["ev_2_0"] },
    { ecosystem: "npm", name: "dayjs", status: "used", repo: null, repo_provenance: null, in_initial_manifest: true, in_final_manifest: true, added_in_session: false, counts: { import_added: 1 }, usage_lines: 1, evidence_ids: ["ev_3_0"] },
    { ecosystem: "npm", name: "react", status: "present_only", repo: null, repo_provenance: null, in_initial_manifest: true, in_final_manifest: true, added_in_session: false, counts: {}, usage_lines: 0, evidence_ids: [] },
  ],
};

test("validator drops hallucinations, zeroes uncorroborated and present-only packages, normalises and caps", () => {
  const v = validate(
    set,
    [
      { ecosystem: "npm", name: "zod", classification: "meaningful", weight: 8, evidence_ids: ["ev_1_0"], rationale: "" },
      { ecosystem: "npm", name: "lodash", classification: "meaningful", weight: 1, evidence_ids: ["ev_2_0"], rationale: "" },
      { ecosystem: "npm", name: "dayjs", classification: "supporting", weight: 1, evidence_ids: ["ev_3_0"], rationale: "" },
      { ecosystem: "npm", name: "react", classification: "meaningful", weight: 5, evidence_ids: ["ev_1_0"], rationale: "" },
      { ecosystem: "npm", name: "left-pad", classification: "meaningful", weight: 5, evidence_ids: ["ev_1_0"], rationale: "" },
    ],
    { maxShare: 0.5 },
  );
  const w = Object.fromEntries(v.weights.map((x) => [x.name, x.weight]));
  assert.equal(w.react, 0);
  assert.equal(w["left-pad"], undefined);
  assert.equal(w.zod, 0.5);
  assert.equal(w.lodash, 0.25);
  assert.equal(w.dayjs, 0.25);
  const codes = v.flags.map((f) => f.code);
  assert.ok(codes.includes("HALLUCINATED_PACKAGE"));
  assert.ok(codes.includes("UNCORROBORATED"));
  assert.ok(codes.includes("CAPPED"));
});

test("cap leftover stays unallocated when it cannot be redistributed", () => {
  const v = validate(set, [{ ecosystem: "npm", name: "zod", classification: "meaningful", weight: 1, evidence_ids: ["ev_1_0"], rationale: "" }], { maxShare: 0.4 });
  assert.equal(v.weights[0].weight, 0.4);
  assert.equal(v.unallocated, 0.6);
});

test("baseline is import count × usage lines and ignores source reads", () => {
  const v = validate(set, baselineProposal(set), { maxShare: 1 });
  const w = Object.fromEntries(v.weights.map((x) => [x.name, x.weight]));
  assert.equal(w.zod, 0.8);
  assert.equal(w.dayjs, 0.2);
  assert.equal(w.lodash, 0);
});

test("money: minor units from Intl and exact largest-remainder splits", () => {
  assert.equal(toMinor("10.05", "USD"), 1005);
  assert.equal(toMinor("1000", "JPY"), 1000);
  assert.equal(fromMinor(1005, "USD"), "10.05");
  const parts = splitByWeights(1000, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
  assert.deepEqual(parts, [334, 333, 333]);
  assert.throws(() => toMinor("1.005", "USD"));
});
