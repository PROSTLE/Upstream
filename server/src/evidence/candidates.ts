import { db, json } from "../db.ts";
import { getPackage, resolveMany, type PackageRecord } from "../resolve/index.ts";
import type { ManifestState } from "./ingest.ts";
import { normalizePypi, type Ecosystem } from "./parse.ts";

export interface EvidenceRow {
  id: string;
  session_id: string;
  hook_event_id: number;
  kind: string;
  ecosystem: Ecosystem | null;
  package: string | null;
  hint: string | null;
  strength: "strong" | "moderate" | "weak";
  detail_json: string;
  created_at: string;
}

export interface LinkedEvidence {
  id: string;
  kind: string;
  strength: string;
  at: string;
  ecosystem?: Ecosystem;
  package?: string;
  link: "direct" | "import_map" | "manifest_name" | "repo" | "docs_host" | "name_in_query" | "library_name";
  detail: Record<string, unknown>;
}

export interface Candidate {
  ecosystem: Ecosystem;
  name: string;
  status: "used" | "consulted" | "present_only";
  repo: string | null;
  repo_provenance: string | null;
  in_initial_manifest: boolean;
  in_final_manifest: boolean;
  added_in_session: boolean;
  counts: Record<string, number>;
  usage_lines: number;
  evidence_ids: string[];
}

export interface CandidateSet {
  session_id: string;
  candidates: Candidate[];
  evidence: LinkedEvidence[];
  unattributed: { id: string; kind: string; reason: string; detail: Record<string, unknown> }[];
  manifest: ManifestState;
}

const CODE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);
const hostOf = (u?: string | null) => {
  try {
    return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, "") : undefined;
  } catch {
    return undefined;
  }
};

export async function buildCandidates(sessionId: string, opts: { resolve?: boolean; maxResolve?: number } = {}): Promise<CandidateSet> {
  const session = db().prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  const manifest = json<ManifestState>(session.manifest_json, {});
  const pyMap = json<Record<string, string[]>>(session.py_import_map_json, {});
  const rows = db()
    .prepare("SELECT * FROM evidence WHERE session_id = ? ORDER BY created_at, id")
    .all(sessionId) as unknown as EvidenceRow[];

  const declared = {
    npm: new Set([...(manifest.initial?.npm ?? []), ...(manifest.latest?.npm ?? [])]),
    pypi: new Set([...(manifest.initial?.pypi ?? []), ...(manifest.latest?.pypi ?? [])].map(normalizePypi)),
  };

  const linked: LinkedEvidence[] = [];
  const unattributed: CandidateSet["unattributed"] = [];
  const pending: EvidenceRow[] = [];

  // Pass 1: evidence that names a package or module directly.
  for (const r of rows) {
    const detail = json<Record<string, unknown>>(r.detail_json, {});
    const base = { id: r.id, kind: r.kind, strength: r.strength, at: r.created_at, detail };
    if (!r.package || !r.ecosystem) {
      pending.push(r);
      continue;
    }
    if (r.ecosystem === "npm") {
      linked.push({ ...base, ecosystem: "npm", package: r.package, link: "direct" });
      continue;
    }
    // PyPI: dep_install / manifest_add / cli_run / docs_fetch already carry distribution names.
    if (["dep_install", "manifest_add", "cli_run", "docs_fetch"].includes(r.kind)) {
      linked.push({ ...base, ecosystem: "pypi", package: normalizePypi(r.package), link: "direct" });
      continue;
    }
    const dists = pyMap[r.package];
    if (dists?.length) {
      for (const d of new Set(dists.map(normalizePypi))) {
        linked.push({ ...base, ecosystem: "pypi", package: d, link: "import_map" });
      }
    } else if (declared.pypi.has(normalizePypi(r.package))) {
      linked.push({ ...base, ecosystem: "pypi", package: normalizePypi(r.package), link: "manifest_name" });
    } else {
      unattributed.push({
        id: r.id,
        kind: r.kind,
        reason: `python module "${r.package}" is not an installed distribution or declared dependency (stdlib or local module)`,
        detail,
      });
    }
  }

  // Every package with direct evidence or a manifest entry becomes a candidate.
  const keys = new Map<string, { ecosystem: Ecosystem; name: string }>();
  const add = (ecosystem: Ecosystem, name: string) => keys.set(`${ecosystem}:${name}`, { ecosystem, name });
  linked.forEach((l) => add(l.ecosystem!, l.package!));
  declared.npm.forEach((n) => add("npm", n));
  declared.pypi.forEach((n) => add("pypi", n));

  if (opts.resolve !== false) await resolveMany([...keys.values()].slice(0, opts.maxResolve));
  const meta = new Map<string, PackageRecord | undefined>();
  for (const [k, v] of keys) meta.set(k, getPackage(v.ecosystem, v.name));

  // Pass 2: docs, MCP lookups and searches matched against resolved metadata.
  for (const r of pending) {
    const detail = json<Record<string, unknown>>(r.detail_json, {});
    const hint = json<{ url?: string; host?: string; repo?: string; query?: string; library?: string }>(r.hint, {});
    const base = { id: r.id, kind: r.kind, strength: r.strength, at: r.created_at, detail };
    const matches: LinkedEvidence[] = [];
    for (const [k, m] of meta) {
      const { ecosystem, name } = keys.get(k)!;
      if (hint.repo && m?.repo && hint.repo === m.repo) {
        matches.push({ ...base, ecosystem, package: name, link: "repo" });
        continue;
      }
      if (hint.host && !CODE_HOSTS.has(hint.host)) {
        const hosts = [hostOf(m?.homepage), hostOf(m?.documentation_url)].filter(
          (h): h is string => Boolean(h) && !CODE_HOSTS.has(h!),
        );
        if (hosts.some((h) => h === hint.host || hint.host!.endsWith(`.${h}`))) {
          matches.push({ ...base, ecosystem, package: name, link: "docs_host" });
          continue;
        }
      }
      if (hint.library && hint.library.toLowerCase() === name.toLowerCase()) {
        matches.push({ ...base, ecosystem, package: name, link: "library_name" });
        continue;
      }
      if (hint.query && name.length >= 3) {
        const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        if (new RegExp(`(^|[^\\w@/-])${esc}($|[^\\w-])`, "i").test(hint.query)) {
          matches.push({ ...base, ecosystem, package: name, link: "name_in_query" });
        }
      }
    }
    if (matches.length) linked.push(...matches);
    else
      unattributed.push({
        id: r.id,
        kind: r.kind,
        reason: hint.url
          ? `no candidate package lists ${hint.host} as its homepage, docs or repo`
          : hint.library
            ? `docs lookup for "${hint.library}" matches no candidate package`
            : "no candidate package named in this query",
        detail,
      });
  }

  const candidates: Candidate[] = [];
  for (const [k, { ecosystem, name }] of keys) {
    const ev = linked.filter((l) => l.ecosystem === ecosystem && l.package === name);
    const counts: Record<string, number> = {};
    let usage = 0;
    for (const e of ev) {
      counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      usage += Number((e.detail as { usage_lines?: number }).usage_lines ?? 0);
    }
    const initial = new Set(ecosystem === "npm" ? manifest.initial?.npm ?? [] : (manifest.initial?.pypi ?? []).map(normalizePypi));
    const final = new Set(ecosystem === "npm" ? manifest.latest?.npm ?? [] : (manifest.latest?.pypi ?? []).map(normalizePypi));
    const codeEvidence = ev.some((e) =>
      ["dep_install", "manifest_add", "import_added", "api_usage", "cli_run", "source_read", "logic_reused"].includes(e.kind),
    );
    const m = meta.get(k);
    candidates.push({
      ecosystem,
      name,
      status: codeEvidence ? "used" : ev.length ? "consulted" : "present_only",
      repo: m?.repo ?? null,
      repo_provenance: m?.repo_provenance ?? null,
      in_initial_manifest: initial.has(name),
      in_final_manifest: final.has(name),
      added_in_session:
        Boolean(counts.dep_install || counts.manifest_add) ||
        (Boolean(manifest.initial) && !initial.has(name) && final.has(name)),
      counts,
      usage_lines: usage,
      evidence_ids: [...new Set(ev.map((e) => e.id))],
    });
  }
  const order = { used: 0, consulted: 1, present_only: 2 };
  candidates.sort((a, b) => order[a.status] - order[b.status] || b.evidence_ids.length - a.evidence_ids.length || a.name.localeCompare(b.name));

  return { session_id: sessionId, candidates, evidence: linked, unattributed, manifest };
}
