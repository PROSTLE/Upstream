import { createHash } from "node:crypto";
import path from "node:path";
import { db, json, now, tx } from "../db.ts";
import { extractEvidence, type HookPayload } from "./extract.ts";
import { depsFromManifestFiles, type ManifestDeps } from "./parse.ts";

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

export interface ManifestState {
  initial?: ManifestDeps & { captured_at: string };
  latest?: ManifestDeps & { captured_at: string };
}

export function ingest(p: IngestPayload): { stored: boolean; evidence: number } {
  if (!p.session_id || !p.hook_event_name) throw new Error("session_id and hook_event_name are required");
  const at = p.upstream?.sent_at ?? now();
  const dedupeKey =
    p.tool_use_id ??
    createHash("sha256")
      .update(`${p.session_id}|${p.hook_event_name}|${at}|${JSON.stringify(p.tool_input ?? {})}`)
      .digest("hex");

  return tx(() => {
    const d = db();
    d.prepare(
      `INSERT INTO sessions(id, cwd, project, transcript_path, started_at, last_event_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_event_at = MAX(sessions.last_event_at, excluded.last_event_at),
         cwd = COALESCE(sessions.cwd, excluded.cwd), transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path)`,
    ).run(p.session_id, p.cwd ?? null, p.cwd ? path.basename(p.cwd) : null, p.transcript_path ?? null, at, at);

    const res = d
      .prepare(
        "INSERT OR IGNORE INTO hook_events(session_id, dedupe_key, hook_event_name, tool_name, received_at, payload_json) VALUES (?,?,?,?,?,?)",
      )
      .run(p.session_id, dedupeKey, p.hook_event_name, p.tool_name ?? null, at, JSON.stringify(p));
    if (Number(res.changes) === 0) return { stored: false, evidence: 0 };
    const eventId = Number(res.lastInsertRowid);

    const manifest = p.upstream?.manifest;
    if (manifest) {
      const row = d.prepare("SELECT manifest_json FROM sessions WHERE id = ?").get(p.session_id) as {
        manifest_json: string | null;
      };
      const state = json<ManifestState>(row.manifest_json, {});
      const deps = { ...depsFromManifestFiles(manifest.files), captured_at: at };
      if (!state.initial) state.initial = deps;
      state.latest = deps;
      d.prepare("UPDATE sessions SET manifest_json = ? WHERE id = ?").run(JSON.stringify(state), p.session_id);
    }
    if (p.upstream?.py_import_map) {
      d.prepare("UPDATE sessions SET py_import_map_json = ? WHERE id = ?").run(
        JSON.stringify(p.upstream.py_import_map),
        p.session_id,
      );
    }
    if (p.hook_event_name === "SessionEnd") {
      d.prepare("UPDATE sessions SET ended_at = ?, end_reason = ?, status = CASE WHEN status = 'open' THEN 'closed' ELSE status END WHERE id = ?").run(
        at,
        p.reason ?? null,
        p.session_id,
      );
    }

    const drafts = extractEvidence(p);
    const insert = d.prepare(
      "INSERT INTO evidence(id, session_id, hook_event_id, kind, ecosystem, package, hint, strength, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    drafts.forEach((e, i) => {
      insert.run(
        `ev_${eventId}_${i}`,
        p.session_id,
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
