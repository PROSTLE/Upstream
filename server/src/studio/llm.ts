// POST /api/studio/llm/responses: the server side of Insights' AG Studio agents.
// The browser's adapter (web/src/insights/ai/adapter.ts) speaks the OpenAI Responses API, which Meta's
// Model API also serves (POST /v1/responses, dev.meta.ai/docs/protocols/responses). This route adds the
// key, pins the model, caps the output, and streams Meta's SSE back unchanged. Nothing about a
// prompt is logged: only token counts.
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { config } from "../config.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Fields the adapter may set. Everything else (model, tool_choice, truncation, background...) is decided here. */
const ALLOWED = ["input", "instructions", "tools", "text", "reasoning", "parallel_tool_calls", "temperature", "top_p"] as const;

export type Limit = { ok: true; prompt: boolean } | { ok: false; status: number; message: string };

/** Sliding-window counters, kept in memory: a restart forgets them, which only ever errs towards allowing. */
export class StudioAiLimiter {
  private prompts = new Map<string, number[]>();
  private calls = new Map<string, number[]>();
  private daily: number[] = [];
  private dailyCalls: number[] = [];
  private readonly opts: { perIpPerHour: number; perDay: number; callsPerPrompt: number };
  constructor(opts: { perIpPerHour: number; perDay: number; callsPerPrompt: number }) {
    this.opts = opts;
  }

  check(ipHash: string, isPrompt: boolean, now = Date.now()): Limit {
    const recent = (m: Map<string, number[]>) => (m.get(ipHash) ?? []).filter((t) => now - t < HOUR);
    const prompts = recent(this.prompts);
    const calls = recent(this.calls);
    this.daily = this.daily.filter((t) => now - t < DAY);
    this.dailyCalls = this.dailyCalls.filter((t) => now - t < DAY);
    if (isPrompt && prompts.length >= this.opts.perIpPerHour)
      return { ok: false, status: 429, message: `That's ${this.opts.perIpPerHour} questions this hour from here, the limit on this demo. Try again later.` };
    if (isPrompt && this.daily.length >= this.opts.perDay)
      return { ok: false, status: 429, message: "The AI on this demo has answered all the questions it can today. Try again tomorrow." };
    // A runaway guard: tool calls continue a prompt, so allow a generous number of model calls per prompt.
    if (calls.length >= Math.max(this.opts.perIpPerHour, 1) * this.opts.callsPerPrompt)
      return { ok: false, status: 429, message: "Too many AI steps from here this hour. Try again later." };
    // And the same for the whole server per day, so the budget holds even for a client that never says "prompt".
    if (this.dailyCalls.length >= Math.max(this.opts.perDay, 1) * this.opts.callsPerPrompt)
      return { ok: false, status: 429, message: "The AI on this demo has answered all the questions it can today. Try again tomorrow." };
    if (isPrompt) {
      prompts.push(now);
      this.daily.push(now);
    }
    calls.push(now);
    this.dailyCalls.push(now);
    this.prompts.set(ipHash, prompts);
    this.calls.set(ipHash, calls);
    return { ok: true, prompt: isPrompt };
  }
}

/** A new prompt is a request whose last input item is something the person typed, not a tool result. */
export function isNewPrompt(body: Record<string, unknown>): boolean {
  const input = Array.isArray(body.input) ? body.input : [];
  const last = input.at(-1) as { type?: string; role?: string } | undefined;
  return last?.type === "message" && last.role === "user";
}

type Json = unknown;
type Obj = Record<string, Json>;
const REF = /^#\/\$defs\/(.+)$/;
const CUT = Symbol("cut");

/** The $defs a schema node refers to, directly. */
function refsIn(node: Json, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => refsIn(n, acc));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const m = k === "$ref" && typeof v === "string" ? REF.exec(v) : null;
      if (m) acc.add(m[1]!);
      else refsIn(v, acc);
    }
  }
  return acc;
}

/** Each recursive $def, mapped to its group (the defs it recurses through), named by the first of them. */
function recursionGroups(defs: Obj): Map<string, string> {
  const edges = new Map(Object.keys(defs).map((d) => [d, refsIn(defs[d])]));
  const reach = new Map<string, Set<string>>();
  for (const from of edges.keys()) {
    const seen = new Set<string>();
    const stack = [...edges.get(from)!];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(edges.get(d) ?? []));
    }
    reach.set(from, seen);
  }
  const group = new Map<string, string>();
  for (const d of edges.keys()) {
    if (!reach.get(d)!.has(d)) continue;
    const members = [...reach.get(d)!].filter((x) => reach.get(x)?.has(d)).sort();
    group.set(d, members[0]!);
  }
  return group;
}

/**
 * Meta's Responses API refuses recursive JSON schemas ("Recursive JSON schemas are not currently supported"),
 * and AG Studio's execute_query tool has two: a filter group holds filters, an expression holds expressions.
 * This unrolls each recursive group `depth[group]` levels deep and, at the bottom, drops the anyOf branch that
 * would recurse. Anything that doesn't recurse is passed through untouched.
 */
export function unrollRecursiveSchema(schema: Json, depth: number | Record<string, number> = 3): Json {
  if (!schema || typeof schema !== "object") return schema;
  const root = schema as Obj;
  const defs = root.$defs as Obj | undefined;
  if (!defs) return schema;
  const group = recursionGroups(defs);
  if (group.size === 0) return schema;
  const groups = [...new Set(group.values())].sort();
  const limit = (g: string) => (typeof depth === "number" ? depth : (depth[g] ?? 1));
  const direct = new Map(Object.keys(defs).map((d) => [d, refsIn(defs[d])]));
  const touches = new Map<string, boolean>();
  const touchesRecursion = (d: string, seen = new Set<string>()): boolean => {
    if (group.has(d)) return true;
    if (touches.has(d)) return touches.get(d)!;
    seen.add(d);
    const t = [...(direct.get(d) ?? [])].some((x) => !seen.has(x) && touchesRecursion(x, seen));
    touches.set(d, t);
    return t;
  };

  const reachesGroup = (d: string, g: string, seen = new Set<string>()): boolean => {
    if (group.get(d) === g) return true;
    seen.add(d);
    return [...(direct.get(d) ?? [])].some((x) => !seen.has(x) && reachesGroup(x, g, seen));
  };

  type Depths = Record<string, number>;
  const out: Record<string, Json | typeof CUT> = {};
  const building = new Set<string>();

  const refTo = (name: string, at: Depths): Json | typeof CUT => {
    if (!(name in defs) || !touchesRecursion(name)) return { $ref: `#/$defs/${name}` };
    const g = group.get(name);
    const next = g ? { ...at, [g]: (at[g] ?? 0) + 1 } : at;
    if (g && next[g]! > limit(g)) return CUT;
    // Copies are told apart only by the depths of groups this def can actually reach.
    const key = `${name}__${groups.filter((x) => reachesGroup(name, x)).map((x) => next[x] ?? 0).join("_")}`;
    if (!(key in out) && !building.has(key)) {
      building.add(key);
      out[key] = walk(defs[name], next);
      building.delete(key);
    }
    return out[key] === CUT ? CUT : { $ref: `#/$defs/${key}` };
  };

  const walk = (node: Json, at: Depths): Json | typeof CUT => {
    if (Array.isArray(node)) {
      const items = node.map((n) => walk(n, at));
      return items.includes(CUT) ? CUT : items;
    }
    if (!node || typeof node !== "object") return node;
    const obj = node as Obj;
    if (typeof obj.$ref === "string") {
      const m = REF.exec(obj.$ref);
      return m ? refTo(m[1]!, at) : obj;
    }
    const res: Obj = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$defs") continue;
      if (k === "anyOf" || k === "oneOf") {
        const branches = (v as Json[]).map((b) => walk(b, at)).filter((b) => b !== CUT);
        if (branches.length === 0) return CUT;
        res[k] = branches;
        continue;
      }
      const w = walk(v, at);
      if (w === CUT) return CUT;
      res[k] = w;
    }
    return res;
  };

  const top = walk(root, {});
  if (top === CUT) return schema;
  const kept: Obj = {};
  for (const d of Object.keys(defs)) if (!touchesRecursion(d)) kept[d] = defs[d];
  for (const [k, v] of Object.entries(out)) if (v !== CUT) kept[k] = v;
  return { ...(top as Obj), $defs: kept };
}

/** Nesting as Meta counts it (measured: it matches its 400s): levels that hold `properties` or `items`, refs followed. */
export function schemaNesting(node: Json, defs: Obj = {}, seen: string[] = []): number {
  if (Array.isArray(node)) return Math.max(0, ...node.map((n) => schemaNesting(n, defs, seen)));
  if (!node || typeof node !== "object") return 0;
  const obj = node as Obj;
  if (seen.length === 0 && obj.$defs) defs = obj.$defs as Obj;
  if (typeof obj.$ref === "string") {
    const name = REF.exec(obj.$ref)?.[1];
    if (!name || seen.includes(name)) return name ? Infinity : 0;
    return schemaNesting(defs[name], defs, [...seen, name]);
  }
  let child = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$defs" || !v || typeof v !== "object") continue;
    child = Math.max(child, schemaNesting(k === "properties" ? Object.values(v) : v, defs, seen.length ? seen : ["#"]));
  }
  return (obj.properties || obj.items ? 1 : 0) + child;
}

export const META_MAX_NESTING = 10;

/**
 * A tool's parameters as Meta will take them: each recursive group unrolled as deep as Meta's nesting limit
 * allows (up to three levels), preferring the choice whose shallowest group is deepest.
 */
export function fitForMeta(schema: Json): Json {
  if (schemaNesting(schema) <= META_MAX_NESTING) return schema;
  const defs = (schema as Obj).$defs as Obj | undefined;
  const groups = defs ? [...new Set(recursionGroups(defs).values())].sort() : [];
  let options: Record<string, number>[] = [{}];
  for (const g of groups.slice(0, 4)) options = options.flatMap((o) => [3, 2, 1].map((d) => ({ ...o, [g]: d })));
  const score = (o: Record<string, number>) => {
    const v = groups.map((g) => o[g] ?? 1);
    return Math.min(...v) * 100 + v.reduce((a, b) => a + b, 0);
  };
  options.sort((a, b) => score(b) - score(a));
  for (const o of options) {
    const s = unrollRecursiveSchema(schema, o);
    if (schemaNesting(s) <= META_MAX_NESTING) return s;
  }
  return unrollRecursiveSchema(schema, 1);
}

/** What is sent to Meta: only the allowed fields, with this server's model, output cap and tool choice. */
export function upstreamBody(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED) if (body[k] !== undefined) out[k] = body[k];
  if (Array.isArray(out.tools))
    out.tools = out.tools.map((t: Record<string, unknown>) =>
      t && typeof t === "object" && t.parameters ? { ...t, parameters: fitForMeta(t.parameters) } : t,
    );
  out.model = config.UPSTREAM_MODEL;
  out.stream = true;
  out.max_output_tokens = config.STUDIO_AI_MAX_OUTPUT_TOKENS;
  out.tool_choice = "auto"; // the only choice Meta's Responses API accepts
  return out;
}

const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: { message } });

/**
 * `delegate` is the route the lead's helpers use (planning, data, page, widget, ledger auditor): their first
 * request also ends in a user message (the task they were handed), so it must not count as a visitor's question.
 * Both routes share the per-address and per-day call ceilings above.
 */
export function studioLlmHandler(limiter: StudioAiLimiter, ipHashOf: (req: Request) => string, { delegate = false } = {}) {
  return async (req: Request, res: Response) => {
    if (!config.STUDIO_AI_ENABLED || !config.MODEL_API_KEY) return fail(res, 503, "AI is off on this demo.");
    const body = req.body;
    if (!body || typeof body !== "object" || !Array.isArray(body.input)) return fail(res, 400, "Expected an OpenAI Responses request.");
    const limit = limiter.check(ipHashOf(req), !delegate && isNewPrompt(body));
    if (!limit.ok) return fail(res, limit.status, limit.message);

    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${new URL(config.MODEL_API_BASE).origin}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${config.MODEL_API_KEY}` },
        body: JSON.stringify(upstreamBody(body)),
        signal: abort.signal,
      });
    } catch (e) {
      if (abort.signal.aborted) return;
      return fail(res, 502, "The AI service could not be reached.");
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      let message = `The AI service answered ${upstream.status}.`;
      try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* not JSON */ }
      // The provider's error text describes the request's shape (a bad parameter), never the prompt.
      console.warn(`[studio-ai] upstream ${upstream.status}: ${message.slice(0, 300)}`);
      return fail(res, upstream.status === 429 ? 429 : 502, message);
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    // Pass every byte through; peek only at the final event for token counts.
    let tail = "";
    const stream = Readable.fromWeb(upstream.body as never);
    stream.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-8000);
      res.write(chunk);
    });
    stream.on("end", () => {
      const m = tail.match(/"input_tokens":(\d+)[\s\S]*?"output_tokens":(\d+)/);
      if (m) console.log(`[studio-ai] ${limit.prompt ? "prompt" : "step"} tokens in=${m[1]} out=${m[2]}`);
      res.end();
    });
    stream.on("error", () => res.end());
  };
}
