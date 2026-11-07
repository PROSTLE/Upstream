import { createHash } from "node:crypto";
import path from "node:path";
import { db, json, LOCAL_USER, now, tx } from "../db.ts";
import { extractEvidence, type EvidenceDraft, type HookPayload } from "./extract.ts";
import { declaredNames, depsFromManifestFiles, ecosystemForFile, sourceFileName, type Ecosystem, type ManifestDeps } from "./parse.ts";

export interface IngestPayload extends HookPayload {
  session_id: string;
  transcript_path?: string;
  tool_use_id?: string;
  reason?: string;
  source?: string;
  upstream?: HookPayload["upstream"] & {
    sent_at?: string;
    manifest?: { files: Record<string, string>; root: string };
    py_import_map?: Record<string, string[]>;
  };
}

/** The last folder name, whichever machine's path style the session came from: an imported session can come from Windows on a Linux server. */
const projectName = (cwd: string) => path.basename(cwd.replace(/\\/g, "/"));

export interface ManifestState {
  initial?: ManifestDeps & { captured_at: string };
  latest?: ManifestDeps & { captured_at: string };
}

/**
 * Records one hook event in this person's space. Their ids are prefixed, because the session and tool ids come from
 * their own machine: without the prefix, someone could send another person's session id and write into that session.
 */
/**
 * Code written without importing a library leaves no import evidence, even if the agent read that library's source first and
 * rewrote its logic. So when new code declares a name that a library file read earlier in this session also declares, or is named
 * after, that is recorded. Only the matching names are kept, and the review decides what they mean.
 */
function reusedLogic(sessionId: string, p: IngestPayload, drafts: EvidenceDraft[]): EvidenceDraft[] {
  if (p.tool_name !== "Write" && p.tool_name !== "Edit" && p.tool_name !== "MultiEdit") return [];
  const input = p.tool_input ?? {};
  const file = String(input.file_path ?? "");
  if (!ecosystemForFile(file)) return [];
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
  const written = edits.map((e) => String(e.content ?? e.new_string ?? "")).join("\n");
  const declared = declaredNames(written);
  if (!declared.size) return [];
  const imported = new Set(drafts.map((d) => d.module));
  const reads = db()
    .prepare("SELECT ecosystem, package, detail_json FROM evidence WHERE session_id = ? AND kind = 'source_read' AND package IS NOT NULL ORDER BY created_at")
    .all(sessionId) as { ecosystem: Ecosystem; package: string; detail_json: string }[];
  const shared = new Map<string, { ecosystem: Ecosystem; names: Set<string>; read: string }>();
  for (const r of reads) {
    if (imported.has(r.package)) continue;
    const detail = json<{ path?: string; excerpt?: string }>(r.detail_json, {});
    const inSource = declaredNames(detail.excerpt ?? "");
    const fileName = sourceFileName(detail.path ?? "");
    if (fileName) inSource.add(fileName);
    const names = [...declared].filter((n) => inSource.has(n));
    if (!names.length) continue;
    const entry = shared.get(r.package) ?? { ecosystem: r.ecosystem, names: new Set<string>(), read: detail.path ?? "" };
    names.forEach((n) => entry.names.add(n));
    shared.set(r.package, entry);
  }
  return [...shared].map(([module, e]) => ({
    kind: "logic_reused" as const,
    ecosystem: e.ecosystem,
    module,
    strength: "moderate" as const,
    detail: { file, tool: p.tool_name, shared_names: [...e.names].slice(0, 10), source_read: e.read },
  }));
}

/** A session or event id as stored for this person. */
export const scopedId = (userId: string, id: string) => (userId === LOCAL_USER ? id : `${userId}.${id}`);

export function ingest(p: IngestPayload, userId: string = LOCAL_USER): { stored: boolean; evidence: number } {
  if (!p.session_id || !p.hook_event_name) throw new Error("session_id and hook_event_name are required");
  const at = p.upstream?.sent_at ?? now();
  const scoped = (id: string) => scopedId(userId, id);
  const sessionId = scoped(p.session_id);
  const dedupeKey = scoped(
    p.tool_use_id ??
    createHash("sha256")
      .update(`${p.session_id}|${p.hook_event_name}|${at}|${JSON.stringify(p.tool_input ?? {})}`)
      .digest("hex"),
  );

  return tx(() => {
    const d = db();
    d.prepare(
      `INSERT INTO sessions(id, cwd, project, transcript_path, started_at, last_event_at, user_id, source)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_event_at = MAX(sessions.last_event_at, excluded.last_event_at),
         started_at = MIN(sessions.started_at, excluded.started_at),
         cwd = COALESCE(sessions.cwd, excluded.cwd), project = COALESCE(sessions.project, excluded.project), transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path)`,
    ).run(sessionId, p.cwd ?? null, p.cwd ? projectName(p.cwd) : null, p.transcript_path ?? null, at, at, userId, p.source === "transcript" ? "transcript" : "hook");

    const res = d
      .prepare(
        "INSERT OR IGNORE INTO hook_events(session_id, dedupe_key, hook_event_name, tool_name, received_at, payload_json) VALUES (?,?,?,?,?,?)",
      )
      .run(sessionId, dedupeKey, p.hook_event_name, p.tool_name ?? null, at, JSON.stringify(p));
    if (Number(res.changes) === 0) return { stored: false, evidence: 0 };
    const eventId = Number(res.lastInsertRowid);

    const manifest = p.upstream?.manifest;
    if (manifest) {
      const row = d.prepare("SELECT manifest_json FROM sessions WHERE id = ?").get(sessionId) as {
        manifest_json: string | null;
      };
      const state = json<ManifestState>(row.manifest_json, {});
      const deps = { ...depsFromManifestFiles(manifest.files), captured_at: at };
      if (!state.initial) state.initial = deps;
      state.latest = deps;
      d.prepare("UPDATE sessions SET manifest_json = ? WHERE id = ?").run(JSON.stringify(state), sessionId);
    }
    if (p.upstream?.py_import_map) {
      d.prepare("UPDATE sessions SET py_import_map_json = ? WHERE id = ?").run(
        JSON.stringify(p.upstream.py_import_map),
        sessionId,
      );
    }
    if (p.hook_event_name === "SessionEnd") {
      d.prepare("UPDATE sessions SET ended_at = ?, end_reason = ?, status = CASE WHEN status = 'open' THEN 'closed' ELSE status END WHERE id = ?").run(
        at,
        p.reason ?? null,
        sessionId,
      );
    }

    const direct = extractEvidence(p);
    const drafts = [...direct, ...reusedLogic(sessionId, p, direct)];
    const insert = d.prepare(
      "INSERT INTO evidence(id, session_id, hook_event_id, kind, ecosystem, package, hint, strength, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    drafts.forEach((e, i) => {
      insert.run(
        `ev_${eventId}_${i}`,
        sessionId,
        eventId,
        e.kind,
        e.ecosystem ?? null,
        e.module ?? null,
        e.hint ? JSON.stringify(e.hint) : null,
        e.strength,
        JSON.stringify(e.detail),
        at,
      );
    });
    return { stored: true, evidence: drafts.length };
  });
}
