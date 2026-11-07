// Past sessions, converted from Claude Code's session files in the browser (web/src/transcript.ts).
// Nothing a client sends is trusted: fields are whitelisted and the redaction runs again here.
import { clipStrings, redactEvent, type TranscriptEvent } from "../../../web/src/transcript.ts";
import { db } from "../db.ts";
import { ingest, scopedId, type IngestPayload } from "./ingest.ts";
import { isManifest } from "./parse.ts";

const SESSION_ID = /^[\w.-]{1,128}$/;
const EVENT_NAMES = new Set(["PostToolUse", "SessionStart", "SessionEnd"]);
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanEvent(raw: Record<string, any>): IngestPayload {
  const up = isObject(raw.upstream) ? raw.upstream : {};
  const upstream: TranscriptEvent["upstream"] = {};
  if (typeof up.sent_at === "string" && !Number.isNaN(Date.parse(up.sent_at))) upstream.sent_at = up.sent_at;
  if (raw.hook_event_name === "PostToolUse" && typeof up.file_head === "string") {
    upstream.file_head = up.file_head.slice(0, 8000);
    upstream.file_head_truncated = up.file_head_truncated === true;
  }
  if (raw.hook_event_name === "SessionStart" && isObject(up.manifest) && isObject(up.manifest.files)) {
    const files = Object.entries(up.manifest.files).filter((f): f is [string, string] => typeof f[1] === "string" && Boolean(isManifest(f[0])) && !/[\\/]/.test(f[0]));
    if (files.length) upstream.manifest = { root: String(up.manifest.root ?? raw.cwd ?? ""), files: Object.fromEntries(files) };
  }
  const event: IngestPayload = {
    hook_event_name: raw.hook_event_name,
    session_id: raw.session_id,
    source: "transcript",
    upstream,
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    ...(raw.hook_event_name === "SessionEnd" ? { reason: "transcript_import" } : {}),
    ...(raw.hook_event_name === "PostToolUse"
      ? { tool_use_id: typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined, tool_name: typeof raw.tool_name === "string" ? raw.tool_name : undefined, tool_input: isObject(raw.tool_input) ? raw.tool_input : {}, tool_response: raw.tool_response }
      : {}),
  };
  return clipStrings(redactEvent(event as Parameters<typeof redactEvent>[0])) as IngestPayload;
}

/** Validates one upload: every event belongs to the same session. Throws a message the person can act on. */
export function cleanTranscriptEvents(raw: unknown): IngestPayload[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("This upload has no events. Is it a Claude Code session file?");
  const sessionId = isObject(raw[0]) ? raw[0].session_id : undefined;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("This upload has no valid session id.");
  return raw.map((e) => {
    if (!isObject(e) || !EVENT_NAMES.has(e.hook_event_name)) throw new Error("This upload has an event that isn't from a session file.");
    if (e.session_id !== sessionId) throw new Error("One upload can only hold one session.");
    return cleanEvent(e);
  });
}

/**
 * Stores the events. No review runs here, because labels only count as blind when they were saved before any review.
 * A session the hook already captured keeps its own start, end and dependency list, so importing it adds nothing that's already there.
 */
export function importTranscript(events: IngestPayload[], userId: string): { session_id: string; stored: number; evidence: number } {
  const sessionId = scopedId(userId, events[0].session_id);
  const existing = db().prepare("SELECT source FROM sessions WHERE id = ?").get(sessionId) as { source: string } | undefined;
  const todo = existing?.source === "hook" ? events.filter((e) => e.hook_event_name === "PostToolUse") : events;
  let stored = 0;
  let evidence = 0;
  for (const e of todo) {
    const r = ingest(e, userId);
    if (r.stored) stored++;
    evidence += r.evidence;
  }
  return { session_id: sessionId, stored, evidence };
}
