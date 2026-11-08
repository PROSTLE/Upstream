// Insights' agent proxy: what reaches Meta, who is limited, and what a visitor sees when AI is off.
import "./helpers/env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { StudioAiLimiter, isNewPrompt, upstreamBody, studioLlmHandler, unrollRecursiveSchema, schemaNesting, fitForMeta, META_MAX_NESTING } = await import("../src/studio/llm.ts");
const { config } = await import("../src/config.ts");

const userTurn = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
const toolTurn = { input: [...userTurn.input, { type: "function_call", call_id: "c1", name: "x", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "{}" }] };

test("a prompt is what a person typed; a tool result continues the same prompt", () => {
  assert.equal(isNewPrompt(userTurn), true);
  assert.equal(isNewPrompt(toolTurn), false);
  assert.equal(isNewPrompt({}), false);
});

test("only the allowed fields reach Meta, with this server's model, output cap and tool choice", () => {
  const out = upstreamBody({ ...userTurn, model: "someone-elses-model", tool_choice: "required", truncation: "auto", background: true, tools: [], reasoning: { effort: "medium" } });
  assert.equal(out.model, config.UPSTREAM_MODEL);
  assert.equal(out.tool_choice, "auto");
  assert.equal(out.stream, true);
  assert.equal(out.max_output_tokens, config.STUDIO_AI_MAX_OUTPUT_TOKENS);
  assert.ok(!("truncation" in out) && !("background" in out));
  assert.deepEqual(out.reasoning, { effort: "medium" });
});

test("each address gets its hourly prompts; tool steps don't use them up; the server has a daily ceiling", () => {
  const l = new StudioAiLimiter({ perIpPerHour: 2, perDay: 3, callsPerPrompt: 5 });
  const t = 1_000_000;
  assert.equal(l.check("a", true, t).ok, true);
  for (let i = 0; i < 3; i++) assert.equal(l.check("a", false, t).ok, true, "steps inside a prompt");
  assert.equal(l.check("a", true, t).ok, true);
  const third = l.check("a", true, t);
  assert.equal(third.ok, false);
  assert.equal(!third.ok && third.status, 429);
  assert.equal(l.check("a", true, t + 3_600_001).ok, true, "an hour later it's allowed again");
  assert.equal(l.check("b", true, t + 3_600_002).ok, false, "but the server's daily ceiling of 3 is reached");
});

test("a run that never settles is stopped", () => {
  const l = new StudioAiLimiter({ perIpPerHour: 1, perDay: 10, callsPerPrompt: 3 });
  assert.equal(l.check("a", true, 0).ok, true);
  assert.equal(l.check("a", false, 1).ok, true);
  assert.equal(l.check("a", false, 2).ok, true);
  assert.equal(l.check("a", false, 3).ok, false);
});

test("with AI off, the proxy answers in plain words and never calls Meta", async () => {
  assert.equal(config.STUDIO_AI_ENABLED, false, "off unless STUDIO_AI_ENABLED=true");
  let status = 0, body: any = null;
  const res: any = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => { calls.push(String(u)); throw new Error("must not be called"); }) as typeof fetch;
  try {
    await studioLlmHandler(new StudioAiLimiter({ perIpPerHour: 5, perDay: 5, callsPerPrompt: 5 }), () => "x")({ body: userTurn } as any, res);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(status, 503);
  assert.equal(body.error.message, "AI is off on this demo.");
  assert.equal(calls.length, 0);
});

// The shape of AG Studio's execute_query filter: a group holds filters, and a filter may be a group.
const recursive = {
  type: "object",
  properties: { filter: { $ref: "#/$defs/Filter" }, field: { $ref: "#/$defs/Field" } },
  required: ["filter", "field"],
  additionalProperties: false,
  $defs: {
    Field: { type: "string", enum: ["ledger.money_in", "ledger.fees"] },
    Filter: { anyOf: [{ type: "object", properties: { field: { $ref: "#/$defs/Field" }, value: { type: "number" } }, required: ["field", "value"], additionalProperties: false }, { $ref: "#/$defs/Group" }] },
    Group: { type: "object", properties: { combinator: { type: "string", enum: ["and", "or"] }, conditions: { type: "array", items: { $ref: "#/$defs/Filter" } } }, required: ["combinator", "conditions"], additionalProperties: false },
  },
};
const refsOf = (x: unknown) => [...JSON.stringify(x).matchAll(/"#\/\$defs\/([^"]+)"/g)].map((m) => m[1]!);

test("recursive tool schemas are unrolled for Meta: no cycles, no dangling refs, a group still holds filters", () => {
  assert.equal(schemaNesting(recursive), Infinity);
  const out: any = unrollRecursiveSchema(recursive, 3);
  for (const r of refsOf(out)) assert.ok(r in out.$defs, `ref ${r} resolves`);
  assert.ok(Number.isFinite(schemaNesting(out)), "no cycle left");
  assert.deepEqual(Object.keys(out.$defs).sort(), ["Field", "Filter__1", "Filter__3", "Group__2"]);
  assert.equal(out.$defs.Filter__3.anyOf.length, 1, "at the bottom only the plain filter is left");
  assert.deepEqual(out.$defs.Field, recursive.$defs.Field, "what doesn't recurse is untouched");
});

test("each tool is fitted within Meta's nesting limit; tools that already fit pass through as they are", () => {
  const fitted = fitForMeta(recursive);
  assert.ok(schemaNesting(fitted) <= META_MAX_NESTING);
  const plain = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  assert.equal(fitForMeta(plain), plain);
  const body = upstreamBody({ ...userTurn, tools: [{ type: "function", name: "q", strict: true, parameters: recursive }] });
  assert.ok(Number.isFinite(schemaNesting((body.tools as any[])[0].parameters)));
});

test("a helper agent's task is not a new question, but its calls still count", () => {
  const l = new StudioAiLimiter({ perIpPerHour: 1, perDay: 1, callsPerPrompt: 3 });
  assert.equal(l.check("a", true, 0).ok, true, "the visitor's question");
  assert.equal(l.check("a", false, 1).ok, true, "a helper handed part of it");
  assert.equal(l.check("a", false, 2).ok, true);
  assert.equal(l.check("b", false, 3).ok, false, "the server's daily call ceiling (perDay x callsPerPrompt) holds for everyone");
});
