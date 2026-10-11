// Pure parsers for imports, install commands and manifests. No network, no config.
import { builtinModules } from "node:module";
import { parse as parseToml } from "smol-toml";

export type Ecosystem = "npm" | "pypi";

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split("/")[0]]));

export function ecosystemForFile(file: string): Ecosystem | undefined {
  const f = file.toLowerCase();
  if (/\.(m|c)?(j|t)sx?$/.test(f) || /\.(vue|svelte|astro)$/.test(f)) return "npm";
  if (/\.pyi?$/.test(f)) return "pypi";
  return undefined;
}

export function isManifest(file: string): "package.json" | "requirements" | "pyproject" | undefined {
  const base = file.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base === "package.json") return "package.json";
  if (/^requirements.*\.(txt|in)$/.test(base)) return "requirements";
  if (base === "pyproject.toml") return "pyproject";
  return undefined;
}

/** PEP 503 normalisation for PyPI distribution names. */
export const normalizePypi = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Bare import specifier -> npm package name, or undefined for relative/builtin/alias imports. */
export function npmPackageFromSpecifier(spec: string): string | undefined {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return undefined;
  if (spec.startsWith("@/") || spec.startsWith("~") || spec.startsWith("#") || spec.includes(":")) return undefined;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (NODE_BUILTINS.has(name)) return undefined;
  if (!NPM_NAME.test(name)) return undefined;
  return name;
}

export interface ImportRef {
  specifier: string;
  module: string; // npm package name, or top-level python module
  bindings: string[];
  typeOnly: boolean;
  line: string;
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

export function parseJsImports(code: string): ImportRef[] {
  const out: ImportRef[] = [];
  const src = stripComments(code);
  const re =
    /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;"'`]*?)\s*from\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']|(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(re)) {
    const spec = m[4] ?? m[5] ?? m[6];
    const pkg = npmPackageFromSpecifier(spec);
    if (!pkg) continue;
    const clause = m[3] ?? "";
    const bindings: string[] = [];
    if (m[1] === "import" && clause) {
      const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (ns) bindings.push(ns[1]);
      const def = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      if (def) bindings.push(def[1]);
      const named = clause.match(/\{([\s\S]*?)\}/);
      if (named) {
        for (const part of named[1].split(",")) {
          const p = part.trim().replace(/^type\s+/, "");
          if (!p) continue;
          const as = p.match(/\bas\s+([A-Za-z_$][\w$]*)/);
          bindings.push(as ? as[1] : p.split(/\s+/)[0]);
        }
      }
    }
    if (m[6]) {
      // const x = require('y') / const { a, b } = require('y')
      const before = src.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + m[0].length);
      const decls = [...before.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*["'][^"']+["']\s*\)$/g)];
      const decl = decls[decls.length - 1];
      if (decl) {
        const d = decl[1];
        if (d.startsWith("{")) d.slice(1, -1).split(",").forEach((s) => {
          const t = s.trim().split(":").pop()!.trim();
          if (t) bindings.push(t);
        });
        else bindings.push(d);
      }
    }
    out.push({
      specifier: spec,
      module: pkg,
      bindings: [...new Set(bindings.filter(Boolean))],
      typeOnly: Boolean(m[2]),
      line: m[0].trim().slice(0, 200),
    });
  }
  return out;
}

export function parsePyImports(code: string): ImportRef[] {
  const out: ImportRef[] = [];
  const src = code.replace(/#.*$/gm, "");
  for (const m of src.matchAll(/^[ \t]*import[ \t]+([^\n]+)$/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      const as = p.match(/^([\w.]+)\s+as\s+(\w+)$/);
      const mod = (as ? as[1] : p.split(/\s+/)[0]).trim();
      if (!/^[A-Za-z_][\w.]*$/.test(mod)) continue;
      const top = mod.split(".")[0];
      out.push({ specifier: mod, module: top, bindings: [as ? as[2] : top], typeOnly: false, line: m[0].trim() });
    }
  }
  for (const m of src.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([\s\S]*?\)|[^\n]+)$/gm)) {
    const mod = m[1];
    if (mod.startsWith(".")) continue;
    const names = m[2].replace(/[()]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    const bindings = names.map((n) => {
      const as = n.match(/^(\w+)\s+as\s+(\w+)$/);
      return as ? as[2] : n.split(/\s+/)[0];
    }).filter((b) => b !== "*");
    out.push({ specifier: mod, module: mod.split(".")[0], bindings, typeOnly: false, line: m[0].trim().slice(0, 200) });
  }
  return out;
}

export function parseImports(code: string, eco: Ecosystem): ImportRef[] {
  return eco === "npm" ? parseJsImports(code) : parsePyImports(code);
}

/** Lines of `code` (excluding import lines) that reference any of `bindings`. */
export function usageLines(code: string, bindings: string[]): number {
  if (!bindings.length) return 0;
  const escaped = bindings.map((b) => b.replace(/[$]/g, "\\$"));
  const re = new RegExp(`(?<![\\w$.])(?:${escaped.join("|")})(?![\\w$])`);
  let n = 0;
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (!t || /^(import|from|export\s.*\sfrom)\b/.test(t) || /\brequire\s*\(/.test(t)) continue;
    if (re.test(t)) n++;
  }
  return n;
}

// ---------- shell commands ----------

function shellSplit(cmd: string): string[][] {
  const segments: string[][] = [];
  let cur: string[] = [];
  let tok = "";
  let quote: string | null = null;
  const push = () => {
    if (tok) cur.push(tok);
    tok = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else tok += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "&" || c === ";" || c === "|" || c === "\n" || c === "(" || c === ")") {
      push();
      if (cur.length) segments.push(cur);
      cur = [];
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    tok += c;
  }
  push();
  if (cur.length) segments.push(cur);
  return segments;
}

export interface CommandRef {
  ecosystem: Ecosystem;
  package: string;
  kind: "dep_install" | "cli_run";
  command: string;
}

const npmSpecName = (s: string) => {
  if (/^(\.|\/|~|file:|git\+|git:|https?:|github:|link:|workspace:)/.test(s)) return undefined;
  const at = s.startsWith("@") ? s.indexOf("@", 1) : s.indexOf("@");
  const name = at > 0 ? s.slice(0, at) : s;
  return NPM_NAME.test(name) ? name : undefined;
};

const pySpecName = (s: string) => {
  if (/^(\.|\/|~|-|git\+|https?:|file:)/.test(s) || /\.(whl|tar\.gz|zip)$/.test(s)) return undefined;
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? normalizePypi(m[1]) : undefined;
};

export function parseCommand(command: string): CommandRef[] {
  const out: CommandRef[] = [];
  for (let seg of shellSplit(command)) {
    while (seg.length && /^[A-Z_]+=/.test(seg[0])) seg = seg.slice(1); // env assignments
    if (seg[0] === "sudo") seg = seg.slice(1);
    const [bin, sub, ...rest] = seg;
    if (!bin) continue;
    const args = (from: string[]) => {
      const names: string[] = [];
      for (let i = 0; i < from.length; i++) {
        const a = from[i];
        if (a.startsWith("-")) {
          if (["-r", "--requirement", "-c", "--constraint", "-e", "--editable", "--index-url", "-i", "--registry", "--prefix", "-C", "--cwd", "--filter", "-w", "--workspace", "-p", "--python", "--with", "--group", "--extra"].includes(a)) i++;
          continue;
        }
        names.push(a);
      }
      return names;
    };
    const b = bin.replace(/\.(cmd|exe)$/i, "").split(/[\\/]/).pop()!;
    if (["npm", "pnpm", "yarn", "bun"].includes(b) && ["install", "i", "add", "isntall"].includes(sub ?? "")) {
      for (const n of args(rest)) {
        const name = npmSpecName(n);
        if (name) out.push({ ecosystem: "npm", package: name, kind: "dep_install", command: seg.join(" ") });
      }
    } else if (["npx", "bunx"].includes(b) || (["pnpm", "yarn"].includes(b) && sub === "dlx")) {
      const first = args(["npx", "bunx"].includes(b) ? [sub, ...rest].filter(Boolean) : rest)[0];
      const name = first ? npmSpecName(first) : undefined;
      if (name) out.push({ ecosystem: "npm", package: name, kind: "cli_run", command: seg.join(" ") });
    } else if (["pip", "pip3"].includes(b) && sub === "install") {
      for (const n of args(rest)) {
        const name = pySpecName(n);
        if (name) out.push({ ecosystem: "pypi", package: name, kind: "dep_install", command: seg.join(" ") });
      }
    } else if (/^python(3(\.\d+)?)?$/.test(b) && sub === "-m" && rest[0] === "pip" && rest[1] === "install") {
      for (const n of args(rest.slice(2))) {
        const name = pySpecName(n);
        if (name) out.push({ ecosystem: "pypi", package: name, kind: "dep_install", command: seg.join(" ") });
      }
    } else if ((b === "uv" && (sub === "add" || (sub === "pip" && rest[0] === "install"))) || (b === "poetry" && sub === "add") || (b === "pdm" && sub === "add")) {
      const from = sub === "pip" ? rest.slice(1) : rest;
      for (const n of args(from)) {
        const name = pySpecName(n);
        if (name) out.push({ ecosystem: "pypi", package: name, kind: "dep_install", command: seg.join(" ") });
      }
    } else if (b === "uvx" || (b === "pipx" && sub === "run") || (b === "uv" && sub === "tool" && rest[0] === "run")) {
      const from = b === "uvx" ? [sub, ...rest].filter(Boolean) : sub === "run" ? rest : rest.slice(1);
      const first = args(from)[0];
      const name = first ? pySpecName(first) : undefined;
      if (name) out.push({ ecosystem: "pypi", package: name, kind: "cli_run", command: seg.join(" ") });
    }
  }
  return out;
}

// ---------- manifests ----------

export interface ManifestDeps {
  npm: string[];
  pypi: string[];
}

export function depsFromPackageJson(text: string): string[] {
  try {
    const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    const names = new Set<string>();
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const n of Object.keys(j[k] ?? {})) names.add(n);
    }
    return [...names];
  } catch {
    return [];
  }
}

export function depsFromRequirements(text: string): string[] {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const n = pySpecName(line);
    if (n) names.add(n);
  }
  return [...names];
}

export function depsFromPyproject(text: string): string[] {
  const names = new Set<string>();
  try {
    const t = parseToml(text) as Record<string, any>;
    const add = (spec: unknown) => {
      if (typeof spec !== "string") return;
      const n = pySpecName(spec);
      if (n && n !== "python") names.add(n);
    };
    (t.project?.dependencies ?? []).forEach(add);
    for (const list of Object.values(t.project?.["optional-dependencies"] ?? {})) (list as unknown[]).forEach(add);
    for (const list of Object.values(t["dependency-groups"] ?? {})) (list as unknown[]).forEach(add);
    for (const k of Object.keys(t.tool?.poetry?.dependencies ?? {})) add(k);
    for (const g of Object.values(t.tool?.poetry?.group ?? {}) as { dependencies?: object }[]) {
      for (const k of Object.keys(g.dependencies ?? {})) add(k);
    }
  } catch {
    // Unparseable pyproject: report nothing rather than guess.
  }
  return [...names];
}

export function depsFromManifestFiles(files: Record<string, string>): ManifestDeps {
  const npm = new Set<string>();
  const pypi = new Set<string>();
  for (const [name, text] of Object.entries(files)) {
    const kind = isManifest(name);
    if (kind === "package.json") depsFromPackageJson(text).forEach((d) => npm.add(d));
    if (kind === "requirements") depsFromRequirements(text).forEach((d) => pypi.add(d));
    if (kind === "pyproject") depsFromPyproject(text).forEach((d) => pypi.add(d));
  }
  return { npm: [...npm].sort(), pypi: [...pypi].sort() };
}

/** Dependency names that appear in `after` text but not in `before` (Edit snippets). */
export function addedManifestDeps(file: string, before: string, after: string): string[] {
  const kind = isManifest(file);
  if (!kind) return [];
  if (kind === "package.json") {
    const pick = (s: string) => {
      const set = new Set<string>();
      for (const m of s.matchAll(/"((?:@[^"/\s]+\/)?[^"/\s]+)"\s*:\s*"((?:[~^<>=]*\s*v?\d)|\*|latest|next|workspace:|npm:|file:|link:|git|https?:)[^"]*"/g)) {
        if (NPM_NAME.test(m[1]) && !["version", "node", "npm"].includes(m[1])) set.add(m[1]);
      }
      return set;
    };
    const a = pick(after);
    for (const d of pick(before)) a.delete(d);
    return [...a];
  }
  const pick = (s: string) => {
    const set = new Set<string>();
    for (const raw of s.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, "").trim().replace(/^["']|["'],?$/g, "");
      if (!line) continue;
      if (kind === "pyproject") {
        const poetry = raw.match(/^\s*([A-Za-z0-9][\w.-]*)\s*=\s*["{]/);
        if (poetry && !/^(name|version|description|python|readme|license|requires-python|build-backend)$/i.test(poetry[1])) {
          set.add(normalizePypi(poetry[1]));
          continue;
        }
        if (!/^[A-Za-z0-9][\w.-]*\s*(\[|[<>=!~]|;|$)/.test(line)) continue;
      }
      const n = pySpecName(line);
      if (n) set.add(n);
    }
    return set;
  };
  const a = pick(after);
  for (const d of pick(before)) a.delete(d);
  return [...a];
}

// ---------- paths & urls ----------

export function dependencyFromPath(p: string): { ecosystem: Ecosystem; module: string } | undefined {
  const s = p.replace(/\\/g, "/");
  const nm = s.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  if (nm) {
    const last = nm[nm.length - 1].replace("node_modules/", "");
    if (!last.startsWith(".")) return { ecosystem: "npm", module: last };
  }
  const sp = s.match(/(?:site|dist)-packages\/([A-Za-z_][\w]*)/);
  if (sp && !/\.(dist|egg)-info$/.test(sp[1])) return { ecosystem: "pypi", module: sp[1] };
  return undefined;
}

export interface UrlHint {
  ecosystem?: Ecosystem;
  package?: string;
  repo?: string;
  host: string;
  url: string;
}

export function hintFromUrl(raw: string): UrlHint | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const hint: UrlHint = { host, url: u.toString() };
  if (host === "npmjs.com" && parts[0] === "package") {
    hint.ecosystem = "npm";
    hint.package = parts[1]?.startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1];
  } else if (host === "pypi.org" && (parts[0] === "project" || parts[0] === "simple")) {
    hint.ecosystem = "pypi";
    hint.package = parts[1] ? normalizePypi(parts[1]) : undefined;
  } else if ((host === "github.com" || host === "raw.githubusercontent.com") && parts.length >= 2) {
    hint.repo = `github.com/${parts[0]}/${parts[1].replace(/\.git$/, "")}`.toLowerCase();
  } else if (host === "unpkg.com" || host === "cdn.jsdelivr.net") {
    const p = host === "cdn.jsdelivr.net" && parts[0] === "npm" ? parts.slice(1) : parts;
    const spec = p[0]?.startsWith("@") ? `${p[0]}/${p[1]}` : p[0];
    const name = spec ? npmSpecName(spec) : undefined;
    if (name) {
      hint.ecosystem = "npm";
      hint.package = name;
    }
  }
  return hint;
}
