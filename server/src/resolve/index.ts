// package -> source repo -> funding signals, from live public APIs, cached in SQLite.
import YAML from "yaml";
import { config } from "../config.ts";
import { db, json, now } from "../db.ts";
import type { Ecosystem } from "../evidence/parse.ts";

export function normalizeRepo(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const m = url
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!m) return undefined;
  return `github.com/${m[1]}/${m[2].replace(/\.git$/, "")}`.toLowerCase();
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "upstream-oss-payouts", ...headers } });
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const DEPSDEV_SYSTEM: Record<Ecosystem, string> = { npm: "npm", pypi: "pypi" };
const ECOSYSTEMS_REGISTRY: Record<Ecosystem, string> = { npm: "npmjs.org", pypi: "pypi.org" };

async function depsDev(eco: Ecosystem, name: string) {
  const base = config.DEPSDEV_API_BASE;
  const pkg = await getJson(`${base}/systems/${DEPSDEV_SYSTEM[eco]}/packages/${encodeURIComponent(name)}`);
  if (pkg.status !== 200) return { error: `deps.dev package ${pkg.status}` };
  const versions = (pkg.body?.versions ?? []) as { versionKey: { version: string }; isDefault?: boolean; publishedAt?: string }[];
  const def = versions.find((v) => v.isDefault) ?? versions[versions.length - 1];
  if (!def) return { error: "deps.dev: no versions" };
  const ver = await getJson(
    `${base}/systems/${DEPSDEV_SYSTEM[eco]}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(def.versionKey.version)}`,
  );
  if (ver.status !== 200) return { error: `deps.dev version ${ver.status}` };
  const related = (ver.body?.relatedProjects ?? []) as {
    projectKey: { id: string };
    relationType: string;
    relationProvenance: string;
  }[];
  const source = related.find((r) => r.relationType === "SOURCE_REPO");
  return {
    version: def.versionKey.version,
    repo: normalizeRepo(source?.projectKey.id ? `https://${source.projectKey.id}` : undefined),
    provenance: source?.relationProvenance,
    links: (ver.body?.links ?? []) as { label: string; url: string }[],
  };
}

function collectFunding(obj: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (!obj || typeof obj !== "object" || depth > 6) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "funding_links" && Array.isArray(v)) v.forEach((u) => typeof u === "string" && out.add(u));
    else if (k === "funding") {
      if (typeof v === "string") out.add(v);
      else if (Array.isArray(v)) v.forEach((x) => (typeof x === "string" ? out.add(x) : (x as any)?.url && out.add((x as any).url)));
      else if ((v as any)?.url) out.add((v as any).url);
    } else if (typeof v === "object") collectFunding(v, out, depth + 1);
  }
  return out;
}

async function ecosystems(eco: Ecosystem, name: string) {
  const r = await getJson(
    `${config.ECOSYSTEMS_API_BASE}/registries/${ECOSYSTEMS_REGISTRY[eco]}/packages/${encodeURIComponent(name)}`,
  );
  if (r.status !== 200) return { error: `ecosyste.ms ${r.status}` };
  const b = r.body ?? {};
  return {
    repo: normalizeRepo(b.repository_url),
    homepage: (b.homepage as string) || undefined,
    documentation_url: (b.documentation_url as string) || undefined,
    registry_url: (b.registry_url as string) || undefined,
    funding: [...collectFunding(b)].filter((u) => /^https?:\/\//.test(u)),
    downloads: b.downloads as number | undefined,
    dependent_repos_count: b.dependent_repos_count as number | undefined,
  };
}

/** The npm registry itself: deps.dev and ecosyste.ms can take a while to index a new package. Claims still prove who runs the repo. */
async function npmRegistry(name: string) {
  const r = await getJson(`${config.NPM_REGISTRY_BASE}/${name.replace("/", "%2F")}/latest`);
  if (r.status !== 200) return { error: `npm registry ${r.status}` };
  const repository = r.body?.repository;
  return { repo: normalizeRepo(typeof repository === "string" ? repository : repository?.url), homepage: (r.body?.homepage as string) || undefined };
}

export async function fetchFundingYml(repo: string): Promise<{ path: string; parsed: Record<string, unknown>; raw: string } | undefined> {
  const [, owner, name] = repo.split("/");
  const headers: Record<string, string> = { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  // GitHub looks for FUNDING.yml in .github/, the repo root, or docs/.
  for (const p of [".github/FUNDING.yml", "FUNDING.yml", "docs/FUNDING.yml"]) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${p}`, {
      headers: { ...headers, "User-Agent": "upstream-oss-payouts" },
    });
    if (res.status === 200) {
      const raw = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = (YAML.parse(raw) as Record<string, unknown>) ?? {};
      } catch {
        parsed = {};
      }
      return { path: p, parsed, raw };
    }
    // Only a 404 means "not here". A rate limit or outage must not read as "this repo has no FUNDING.yml".
    if (res.status !== 404) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new Error(
        remaining === "0"
          ? `GitHub's API rate limit is used up${config.GITHUB_TOKEN ? "" : " (set GITHUB_TOKEN for a higher limit)"}; try again later.`
          : `GitHub answered HTTP ${res.status} while reading ${p} in ${repo}.`,
      );
    }
  }
  return undefined;
}

export interface PackageRecord {
  ecosystem: Ecosystem;
  name: string;
  repo: string | null;
  repo_provenance: string | null;
  homepage: string | null;
  documentation_url: string | null;
  registry_url: string | null;
  funding_links: string[];
  funding_yml: Record<string, unknown> | null;
  sources: Record<string, unknown>;
  resolved_at: string | null;
  resolve_error: string | null;
}

export function getPackage(eco: Ecosystem, name: string): PackageRecord | undefined {
  const r = db().prepare("SELECT * FROM packages WHERE ecosystem = ? AND name = ?").get(eco, name) as any;
  if (!r) return undefined;
  return {
    ...r,
    funding_links: json<string[]>(r.funding_links_json, []),
    funding_yml: json<Record<string, unknown> | null>(r.funding_yml_json, null),
    sources: json<Record<string, unknown>>(r.sources_json, {}),
  };
}

export async function resolvePackage(eco: Ecosystem, name: string, force = false): Promise<PackageRecord> {
  const cached = getPackage(eco, name);
  const fresh =
    cached?.resolved_at &&
    Date.now() - new Date(cached.resolved_at).getTime() < config.METADATA_CACHE_HOURS * 3600 * 1000;
  if (cached && fresh && !force) return cached;

  const [dd, es] = await Promise.allSettled([depsDev(eco, name), ecosystems(eco, name)]);
  const d = dd.status === "fulfilled" ? dd.value : { error: String(dd.reason) };
  const e = es.status === "fulfilled" ? es.value : { error: String(es.reason) };
  const dRepo = "repo" in d ? d.repo : undefined;
  const eRepo = "repo" in e ? e.repo : undefined;
  const n = !dRepo && !eRepo && eco === "npm" ? await npmRegistry(name).catch((err) => ({ error: String(err) })) : undefined;
  const nRepo = n && "repo" in n ? n.repo : undefined;
  // A failed lookup must not forget a repo already known: money held for that repo would stop being payable.
  const repo = dRepo ?? eRepo ?? nRepo ?? cached?.repo ?? null;
  const provenance = dRepo ? `deps.dev:${(d as any).provenance ?? "UNKNOWN"}` : eRepo ? "ecosyste.ms:repository_url" : nRepo ? "npm-registry:repository" : (cached?.repo_provenance ?? null);
  // A package found through the registry is resolved; the indexes simply haven't caught up yet.
  const errors = nRepo ? [] : [("error" in d && d.error) || "", ("error" in e && e.error) || ""].filter(Boolean);

  let fundingYml: Awaited<ReturnType<typeof fetchFundingYml>>;
  try {
    fundingYml = repo ? await fetchFundingYml(repo) : undefined;
  } catch (err) {
    errors.push(`FUNDING.yml: ${String(err)}`);
  }
  const funding = new Set<string>("funding" in e ? e.funding : []);
  for (const v of Object.values(fundingYml?.parsed ?? {})) {
    for (const u of Array.isArray(v) ? v : [v]) if (typeof u === "string" && /^https?:\/\//.test(u)) funding.add(u);
  }

  const record = {
    ecosystem: eco,
    name,
    repo,
    repo_provenance: provenance,
    homepage: ("homepage" in e && e.homepage) || (n && "homepage" in n && n.homepage) || null,
    documentation_url: ("documentation_url" in e && e.documentation_url) || null,
    registry_url: ("registry_url" in e && e.registry_url) || null,
    funding_links: [...funding],
    funding_yml: fundingYml ? { path: fundingYml.path, ...fundingYml.parsed } : null,
    sources: {
      depsdev: d,
      ecosystems: e,
      npm_registry: n,
      repo_conflict: dRepo && eRepo && dRepo !== eRepo ? { depsdev: dRepo, ecosystems: eRepo } : undefined,
    },
    resolved_at: now(),
    resolve_error: errors.length ? errors.join("; ") : null,
  };
  db()
    .prepare(
      `INSERT INTO packages(ecosystem, name, repo, repo_provenance, homepage, documentation_url, registry_url, funding_links_json, funding_yml_json, sources_json, resolved_at, resolve_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(ecosystem, name) DO UPDATE SET repo=excluded.repo, repo_provenance=excluded.repo_provenance,
         homepage=excluded.homepage, documentation_url=excluded.documentation_url, registry_url=excluded.registry_url,
         funding_links_json=excluded.funding_links_json, funding_yml_json=excluded.funding_yml_json,
         sources_json=excluded.sources_json, resolved_at=excluded.resolved_at, resolve_error=excluded.resolve_error`,
    )
    .run(
      eco,
      name,
      record.repo,
      record.repo_provenance,
      record.homepage,
      record.documentation_url,
      record.registry_url,
      JSON.stringify(record.funding_links),
      record.funding_yml ? JSON.stringify(record.funding_yml) : null,
      JSON.stringify(record.sources),
      record.resolved_at,
      record.resolve_error,
    );
  return record;
}

/** Resolve with bounded concurrency to stay polite to public APIs. */
export async function resolveMany(items: { ecosystem: Ecosystem; name: string }[], force = false) {
  const results: PackageRecord[] = [];
  const queue = [...items];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const it = queue.shift()!;
      try {
        results.push(await resolvePackage(it.ecosystem, it.name, force));
      } catch (err) {
        console.warn(`resolve ${it.ecosystem}/${it.name} failed:`, err);
      }
    }
  });
  await Promise.all(workers);
  return results;
}
