// Turns a Claude Code session file (JSONL) into the events the live hook would have sent for that session.
// Pure TypeScript with no DOM and no Node APIs: the browser, scripts/make-sample.ts and the server all import this file.
// The file format is undocumented and can change, so every field is read defensively.

const MAX_FIELD = 20_000;
const FILE_HEAD = 8_000;

// The same patterns as hook/upstream-hook.mjs and hook/hooks.json. server/test/transcript.test.ts keeps them in step.
export const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|\.npmrc|\.pypirc)$/i;
export const SOURCE_FILE = /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro|py|pyi)$/i;
export const RECORDED_TOOLS = /^(?:Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|mcp__.*)$/;
const DEPENDENCY_FILE = /node_modules|site-packages|dist-packages/;
const MANIFEST_FILE = /^(package\.json|pyproject\.toml|requirements.*\.(txt|in))$/i;
const PYTHON_FILE = /\.(py|pyi|ipynb)$|site-packages|dist-packages/i;

export const PYTHON_WARNING = "Python import names are matched by package name only (the live hook maps them exactly).";
const partialEditsWarning = (n: number) => `${n} ${n === 1 ? "edit changed a file" : "edits changed files"} this session never showed in full, so new code using ${n === 1 ? "its" : "their"} existing imports may be missed.`;
const MIXED_SESSIONS_WARNING = "This file holds more than one session id. Only the most common one is used.";
const NO_SESSION_WARNING = "No session id found. Is this a Claude Code session file?";

/** Text the server may show on a shareable page. A warning sent by a client is only displayed when it matches one of these. */
export const isKnownWarning = (w: unknown): w is string =>
  typeof w === "string" && (w === PYTHON_WARNING || w === MIXED_SESSIONS_WARNING || w === NO_SESSION_WARNING || /^\d+ (edit changed a file|edits changed files) this session never showed in full, so new code using (its|their) existing imports may be missed\.$/.test(w));

export interface TranscriptEvent {
  hook_event_name: "PostToolUse" | "SessionStart" | "SessionEnd";
  session_id: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
  reason?: string;
  source: "transcript";
  upstream: {
    sent_at?: string;
    file_head?: string;
    file_head_truncated?: boolean;
    manifest?: { root: string; files: Record<string, string> };
  };
}

export interface TranscriptStats {
  lines: number;
  toolCalls: number;
  kept: number;
  skipped: number;
  tornLines: number;
}

export interface TranscriptResult {
  sessionId: string | null;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  events: TranscriptEvent[];
  stats: TranscriptStats;
  warnings: string[];
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

export function clipStrings<T>(value: T, depth = 0): T {
  if (typeof value === "string") return (value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) + "\n…[truncated by upstream]" : value) as T;
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, depth + 1)])) as T;
}

/**
 * The hook's redaction, plus one rule: tool output is only kept for reads of dependency files, the one place evidence uses it.
 * In a session file, Bash output, Grep lines and Edit's originalFile all carry the person's own code, which must stay in their browser.
 * The server applies this again to everything it receives.
 */
export function redactEvent<E extends Pick<TranscriptEvent, "hook_event_name"> & { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; upstream?: { file_head?: string; file_head_truncated?: boolean } }>(event: E): E {
  if (event.hook_event_name !== "PostToolUse") return event;
  const input = event.tool_input ?? {};
  const file = String(input.file_path ?? input.notebook_path ?? "");
  if (file && SECRET_FILE.test(file)) {
    const { file_head: _head, file_head_truncated: _truncated, ...upstream } = event.upstream ?? {};
    return { ...event, tool_input: { file_path: file, redacted: true }, tool_response: { redacted: true }, upstream };
  }
  if (event.tool_name === "Read" && DEPENDENCY_FILE.test(file)) return event;
  return { ...event, tool_response: { omitted: true } };
}

/** Removes the "   12→" or "12<tab>" line numbers from a Read result (real files use the tab form; older ones used the arrow), and the reminder the agent gets after a read. */
export function stripLineNumbers(text: string): string {
  return text
    .split(/\n*<system-reminder>/)[0]
    .split("\n")
    .map((line) => line.replace(/^\s*\d+(?:→|\t)/, ""))
    .join("\n");
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((b) => (isObject(b) && typeof b.text === "string" ? [b.text] : [])).join("\n");
}

const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, (m) => m.toLowerCase());

function isDirectlyIn(file: string, dir: string | null): string | undefined {
  if (!dir) return undefined;
  const f = normalizePath(file);
  const root = normalizePath(dir).replace(/\/+$/, "");
  if (!f.startsWith(`${root}/`)) return undefined;
  const rest = f.slice(root.length + 1);
  return rest.includes("/") ? undefined : rest;
}

interface KnownFile {
  text: string;
  /** False when only the start of the file is known, from a read with a line limit. */
  complete: boolean;
}

function applyEdit(text: string, oldString: unknown, newString: unknown, replaceAll: unknown): string {
  if (typeof oldString !== "string" || typeof newString !== "string" || !oldString) return text;
  if (replaceAll === true) return text.split(oldString).join(newString);
  const at = text.indexOf(oldString);
  return at < 0 ? text : text.slice(0, at) + newString + text.slice(at + oldString.length);
}

/** On a line with several results, toolUseResult describes only one of them: it's only used when its path matches this call. */
function resultFor(use: PendingUse, toolUseResult: unknown): Record<string, any> | undefined {
  if (!isObject(toolUseResult)) return undefined;
  const expected = String(use.input.file_path ?? "");
  const reported = toolUseResult.filePath ?? toolUseResult.file?.filePath;
  if (typeof reported === "string" && expected && normalizePath(reported) !== normalizePath(expected)) return undefined;
  return toolUseResult;
}

interface PendingUse {
  id: string;
  name: string;
  input: Record<string, any>;
  at?: string;
  cwd?: string;
}

function readResponse(result: Record<string, any> | undefined, content: unknown): unknown {
  if (result?.file && typeof result.file.content === "string") {
    const { filePath, content: text, numLines, startLine, totalLines } = result.file;
    return { type: result.type, file: { filePath, content: text, numLines, startLine, totalLines } };
  }
  if (result) return { type: result.type };
  return stripLineNumbers(flatten(content));
}

export function transcriptToEvents(text: string, opts: { manifests?: Record<string, string> } = {}): TranscriptResult {
  const stats: TranscriptStats = { lines: 0, toolCalls: 0, kept: 0, skipped: 0, tornLines: 0 };
  const uses = new Map<string, PendingUse>();
  const answered = new Set<string>();
  const sessionCounts = new Map<string, number>();
  const files = new Map<string, KnownFile>();
  const manifests = new Map<string, string>();
  const body: TranscriptEvent[] = [];
  let cwd: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let python = false;
  let partialEdits = 0;

  const learn = (path: string, known: KnownFile | undefined) => {
    if (!known || !path || SECRET_FILE.test(path)) return;
    files.set(normalizePath(path), known);
    const name = isDirectlyIn(path, cwd);
    if (name && MANIFEST_FILE.test(name) && known.complete) manifests.set(name, known.text);
  };

  const handleResult = (use: PendingUse, block: Record<string, any>, line: Record<string, any>) => {
    // The live hook's PostToolUse only fires when a tool succeeds, so a failed Edit or install leaves no trace here either.
    if (block.is_error === true) return;
    const result = resultFor(use, line.toolUseResult);
    const path = String(use.input.file_path ?? use.input.notebook_path ?? "");

    if (use.name === "Read" && path) {
      const file = result?.file;
      if (isObject(file) && typeof file.content === "string") {
        if (file.startLine === 1 || file.startLine === undefined) learn(path, { text: file.content, complete: file.numLines === undefined || file.numLines === file.totalLines });
      } else if (!result && !use.input.offset) {
        const flat = flatten(block.content);
        if (flat && !flat.startsWith("<system-reminder>")) learn(path, { text: stripLineNumbers(flat), complete: !use.input.limit });
      }
    }
    if (use.name === "Write" && typeof use.input.content === "string") learn(path, { text: use.input.content, complete: true });
    if (use.name === "Edit" || use.name === "MultiEdit") {
      const original = typeof result?.originalFile === "string" ? { text: result.originalFile, complete: true } : files.get(normalizePath(path));
      if (original) {
        const edits: Record<string, unknown>[] = use.name === "MultiEdit" && Array.isArray(use.input.edits) ? use.input.edits : [use.input];
        learn(path, { text: edits.reduce((t, e) => applyEdit(t, e.old_string, e.new_string, e.replace_all), original.text), complete: original.complete });
      } else if (SOURCE_FILE.test(path)) partialEdits++;
    }

    if (!RECORDED_TOOLS.test(use.name)) return;
    stats.kept++;
    if (PYTHON_FILE.test(path) || PYTHON_FILE.test(String(use.input.path ?? ""))) python = true;

    const upstream: TranscriptEvent["upstream"] = { sent_at: typeof line.timestamp === "string" ? line.timestamp : use.at };
    if ((use.name === "Edit" || use.name === "MultiEdit" || use.name === "Write") && SOURCE_FILE.test(path)) {
      const known = files.get(normalizePath(path));
      if (known) {
        upstream.file_head = known.text.slice(0, FILE_HEAD);
        upstream.file_head_truncated = known.text.length > FILE_HEAD || !known.complete;
      }
    }
    const response = use.name === "Read" ? readResponse(result, block.content) : isObject(line.toolUseResult) ? line.toolUseResult : flatten(block.content);
    body.push(
      clipStrings(
        redactEvent<TranscriptEvent>({
          hook_event_name: "PostToolUse",
          session_id: "",
          tool_use_id: use.id,
          tool_name: use.name,
          tool_input: use.input,
          tool_response: response,
          cwd: (typeof line.cwd === "string" ? line.cwd : use.cwd) ?? cwd ?? undefined,
          source: "transcript",
          upstream,
        }),
      ),
    );
  };

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    stats.lines++;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      stats.tornLines++;
      continue;
    }
    if (!isObject(line)) {
      stats.tornLines++;
      continue;
    }
    if (typeof line.sessionId === "string") sessionCounts.set(line.sessionId, (sessionCounts.get(line.sessionId) ?? 0) + 1);
    if (cwd === null && typeof line.cwd === "string") cwd = line.cwd;
    if (typeof line.timestamp === "string") {
      if (!startedAt || line.timestamp < startedAt) startedAt = line.timestamp;
      if (!endedAt || line.timestamp > endedAt) endedAt = line.timestamp;
    }
    // Subagent lines (isSidechain) are real agent work and go through the same path.
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && !uses.has(block.id)) {
        uses.set(block.id, { id: block.id, name: block.name, input: isObject(block.input) ? block.input : {}, at: typeof line.timestamp === "string" ? line.timestamp : undefined, cwd: typeof line.cwd === "string" ? line.cwd : undefined });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string" && !answered.has(block.tool_use_id)) {
        const use = uses.get(block.tool_use_id);
        if (!use) continue;
        answered.add(block.tool_use_id);
        handleResult(use, block, line);
      }
    }
  }

  stats.toolCalls = uses.size;
  stats.skipped = stats.toolCalls - stats.kept;

  const warnings: string[] = [];
  const sessionId = [...sessionCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!sessionId) warnings.push(NO_SESSION_WARNING);
  if (sessionCounts.size > 1) warnings.push(MIXED_SESSIONS_WARNING);
  if (python) warnings.push(PYTHON_WARNING);
  if (partialEdits) warnings.push(partialEditsWarning(partialEdits));
  if (!sessionId) return { sessionId, cwd, startedAt, endedAt, events: [], stats, warnings };

  const declared = { ...Object.fromEntries(manifests), ...opts.manifests };
  const events: TranscriptEvent[] = [];
  if (Object.keys(declared).length && cwd) {
    events.push(clipStrings<TranscriptEvent>({ hook_event_name: "SessionStart", session_id: sessionId, cwd, source: "transcript", upstream: { sent_at: startedAt ?? undefined, manifest: { root: cwd, files: declared } } }));
  }
  for (const e of body) events.push({ ...e, session_id: sessionId });
  events.push({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: cwd ?? undefined, reason: "transcript_import", source: "transcript", upstream: { sent_at: endedAt ?? undefined } });
  return { sessionId, cwd, startedAt, endedAt, events, stats, warnings };
}

/** Splits events into batches that each fit the server's request limit. A single event is never split. */
export function chunkEvents(events: TranscriptEvent[], maxBytes: number): TranscriptEvent[][] {
  const encoder = new TextEncoder();
  const chunks: TranscriptEvent[][] = [];
  let current: TranscriptEvent[] = [];
  let size = 0;
  for (const e of events) {
    const n = encoder.encode(JSON.stringify(e)).length + 1;
    if (current.length && size + n > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** "412 lines · 63 tool calls · 41 kept · 1 torn line" */
export function describeStats(s: TranscriptStats): string {
  const parts = [`${s.lines} lines`, `${s.toolCalls} tool calls`, `${s.kept} kept`];
  if (s.tornLines) parts.push(`${s.tornLines} torn line${s.tornLines === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
