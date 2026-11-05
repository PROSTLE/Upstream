// Checks the request sent to Meta's Model API against dev.meta.ai/docs/protocols/messages, using a local server.
import "./helpers/env.ts";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { CandidateSet } from "../src/evidence/candidates.ts";

type Seen = { url: string; headers: http.IncomingHttpHeaders; body: any };
let seen: Seen | undefined;
let reply: { stop_reason: string; text: string };

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    seen = { url: req.url ?? "", headers: req.headers, body: JSON.parse(data) };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "muse-spark-1.3",
      content: [{ type: "text", text: reply.text }],
      stop_reason: reply.stop_reason, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});

let llmProposal: typeof import("../src/attribution/llm.ts").llmProposal;
const emptySet = { candidates: [], evidence: [] } as unknown as CandidateSet;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.MODEL_API_KEY = "LLM_test_secret";
  process.env.MODEL_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "must-not-be-sent";
  ({ llmProposal } = await import("../src/attribution/llm.ts"));
});
after(() => {
  delete process.env.ANTHROPIC_API_KEY;
  server.close();
});

test("sends a documented Messages request with a Bearer key and parses the reply", async () => {
  const output = {
    packages: [{ ecosystem: "npm", name: "zod", classification: "meaningful", weight: 1, evidence_ids: ["e1"], rationale: "Used for validation." }],
    session_summary: "Added validation.",
    concerns: [],
  };
  reply = { stop_reason: "end_turn", text: JSON.stringify(output) };
  const result = await llmProposal(emptySet);

  assert.equal(seen?.url, "/v1/messages");
  assert.equal(seen?.headers.authorization, "Bearer LLM_test_secret");
  assert.equal(seen?.headers["x-api-key"], undefined);
  assert.equal(seen?.headers["anthropic-beta"], undefined);
  assert.equal(seen?.body.model, "muse-spark-1.3");
  assert.equal(seen?.body.output_config.effort, "medium");
  assert.equal(seen?.body.output_config.format.type, "json_schema");
  assert.equal(seen?.body.output_config.format.schema.type, "object");
  assert.equal(seen?.body.fallbacks, undefined);
  assert.deepEqual(result.proposal, output.packages);
  assert.equal(result.model, "muse-spark-1.3");
});

test("refused, truncated and off-schema replies are errors, not empty attributions", async () => {
  reply = { stop_reason: "refusal", text: "" };
  await assert.rejects(llmProposal(emptySet), /declined/);
  reply = { stop_reason: "max_tokens", text: "{" };
  await assert.rejects(llmProposal(emptySet), /truncated/);
  reply = { stop_reason: "end_turn", text: JSON.stringify({ packages: "none" }) };
  await assert.rejects(llmProposal(emptySet), /did not match the schema/);
});
