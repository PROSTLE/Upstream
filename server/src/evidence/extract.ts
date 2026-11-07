// Turns one Claude Code PostToolUse payload into deterministic evidence drafts.
// Field names follow code.claude.com/docs/en/hooks (tool_name, tool_input, tool_response).
import {
  addedManifestDeps,
  dependencyFromPath,
  ecosystemForFile,
  hintFromUrl,
  isManifest,
  parseCommand,
  parseImports,
  usageLines,
  type Ecosystem,
} from "./parse.ts";

export type EvidenceKind =
  | "dep_install"
  | "cli_run"
  | "manifest_add"
  | "import_added"
  | "api_usage"
  | "source_read"
  | "source_search"
  | "logic_reused"
  | "docs_fetch"
  | "docs_mcp"
  | "web_search";

export type Strength = "strong" | "moderate" | "weak";

export interface EvidenceDraft {
  kind: EvidenceKind;
  ecosystem?: Ecosystem;
  /** npm package name, or python top-level module (mapped to a distribution later). */
  module?: string;
  hint?: { url?: string; host?: string; repo?: string; query?: string; library?: string; package?: string };
  strength: Strength;
  detail: Record<string, unknown>;
}

export interface HookPayload {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
  /** Added by Upstream's hook script on the developer's machine. */
  upstream?: { file_head?: string; file_head_truncated?: boolean };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Grabs readable text from a tool_response of unknown shape (for excerpts only). */
export function responseText(resp: unknown, max = 1500): string {
  if (typeof resp === "string") return clip(resp, max);
  if (!resp || typeof resp !== "object") return "";
  // Claude Code's Read result is { file: { filePath, content, ... } }: a long filePath must not be taken for the contents.
  const content = (resp as { file?: { content?: unknown } }).file?.content;
  if (typeof content === "string") return clip(content, max);
  const stack: unknown[] = [resp];
  while (stack.length) {
    const v = stack.shift();
    if (typeof v === "string" && v.length > 40) return clip(v, max);
    if (v && typeof v === "object") stack.push(...Object.values(v as object));
  }
  return "";
}

function codeEdits(input: Record<string, unknown>): { before: string; after: string }[] {
  if (Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).map((e) => ({
      before: str(e.old_string),
      after: str(e.new_string),
    }));
  }
  if ("new_string" in input) return [{ before: str(input.old_string), after: str(input.new_string) }];
  if ("content" in input) return [{ before: "", after: str(input.content) }];
  if ("new_source" in input) return [{ before: "", after: str(input.new_source) }];
  return [];
}

export function extractEvidence(p: HookPayload): EvidenceDraft[] {
  if (p.hook_event_name !== "PostToolUse" || !p.tool_name) return [];
  const tool = p.tool_name;
  const input = p.tool_input ?? {};
  const out: EvidenceDraft[] = [];

  // Claude Code on Windows runs commands through its PowerShell tool; both carry the command in tool_input.command.
  if (tool === "Bash" || tool === "PowerShell") {
    const command = str(input.command);
    for (const c of parseCommand(command)) {
      out.push({
        kind: c.kind,
        ecosystem: c.ecosystem,
        module: c.package,
        strength: c.kind === "dep_install" ? "strong" : "moderate",
        detail: { command: clip(c.command, 300) },
      });
    }
    return out;
  }

  if (tool === "Edit" || tool === "MultiEdit" || tool === "Write" || tool === "NotebookEdit") {
    const file = str(input.file_path) || str(input.notebook_path);
    const edits = codeEdits(input);
    const manifest = isManifest(file);
    if (manifest) {
      const eco: Ecosystem = manifest === "package.json" ? "npm" : "pypi";
      const added = new Set<string>();
      for (const e of edits) addedManifestDeps(file, e.before, e.after).forEach((d) => added.add(d));
      for (const name of added) {
        out.push({
          kind: "manifest_add",
          ecosystem: eco,
          module: name,
          strength: "strong",
          detail: { file, tool },
        });
      }
      return out;
    }
    const eco = ecosystemForFile(file.endsWith(".ipynb") ? "x.py" : file);
    if (!eco) return out;
    const head = p.upstream?.file_head ?? "";
    const fileImports = head ? parseImports(head, eco) : [];
    const newImportModules = new Set<string>();
    for (const e of edits) {
      const before = new Set(parseImports(e.before, eco).map((i) => `${i.module}|${i.specifier}`));
      for (const imp of parseImports(e.after, eco)) {
        if (before.has(`${imp.module}|${imp.specifier}`)) continue;
        // Usage counts lines in the added code that reference this import's bindings.
        const lines = usageLines(e.after, imp.bindings);
        newImportModules.add(imp.module);
        out.push({
          kind: "import_added",
          ecosystem: eco,
          module: imp.module,
          strength: imp.typeOnly ? "weak" : lines > 0 ? "strong" : "moderate",
          detail: {
            file,
            tool,
            specifier: imp.specifier,
            bindings: imp.bindings,
            usage_lines: lines,
            type_only: imp.typeOnly,
            import_line: imp.line,
            new_file: !e.before && tool === "Write",
          },
        });
      }
    }
    // Code added against imports that already existed in the file.
    for (const imp of fileImports) {
      if (newImportModules.has(imp.module)) continue;
      let lines = 0;
      const samples: string[] = [];
      for (const e of edits) {
        const beforeCount = usageLines(e.before, imp.bindings);
        const afterCount = usageLines(e.after, imp.bindings);
        const delta = afterCount - beforeCount;
        if (delta > 0) {
          lines += delta;
          const sample = e.after
            .split("\n")
            .find((l) => imp.bindings.some((b) => new RegExp(`(?<![\\w$.])${b.replace(/\$/g, "\\$")}(?![\\w$])`).test(l)));
          if (sample) samples.push(clip(sample.trim(), 160));
        }
      }
      if (lines > 0) {
        out.push({
          kind: "api_usage",
          ecosystem: eco,
          module: imp.module,
          strength: lines >= 3 ? "strong" : "moderate",
          detail: { file, tool, bindings: imp.bindings, usage_lines: lines, samples: samples.slice(0, 3) },
        });
      }
    }
    return out;
  }

  if (tool === "Read" || tool === "Grep" || tool === "Glob") {
    const path = str(input.file_path) || str(input.path) || str(input.pattern);
    const dep = dependencyFromPath(path);
    if (dep) {
      out.push({
        kind: tool === "Read" ? "source_read" : "source_search",
        ecosystem: dep.ecosystem,
        module: dep.module,
        strength: tool === "Read" ? "moderate" : "weak",
        detail: {
          path,
          tool,
          excerpt: tool === "Read" ? responseText(p.tool_response, 1500) : undefined,
          pattern: tool !== "Read" ? str(input.pattern) : undefined,
        },
      });
    }
    return out;
  }

  if (tool === "WebFetch") {
    const url = str(input.url);
    const h = hintFromUrl(url);
    if (h) {
      out.push({
        kind: "docs_fetch",
        ecosystem: h.ecosystem,
        module: h.package,
        hint: { url: h.url, host: h.host, repo: h.repo, package: h.package },
        strength: "moderate",
        detail: { url: h.url, prompt: clip(str(input.prompt), 300) },
      });
    }
    return out;
  }

  if (tool === "WebSearch") {
    const query = str(input.query);
    if (query) out.push({ kind: "web_search", hint: { query }, strength: "weak", detail: { query: clip(query, 300) } });
    return out;
  }

  if (tool.startsWith("mcp__")) {
    // Context7 exposes resolve-library-id(libraryName, query) and query-docs(libraryId, query).
    const libraryName = str(input.libraryName);
    const libraryId = str(input.libraryId) || str(input.context7CompatibleLibraryID);
    if (libraryName || libraryId) {
      const repoMatch = libraryId.match(/^\/([^/]+)\/([^/]+)/);
      out.push({
        kind: "docs_mcp",
        hint: {
          library: libraryName || libraryId,
          repo: repoMatch ? `github.com/${repoMatch[1]}/${repoMatch[2]}`.toLowerCase() : undefined,
          query: str(input.query) || undefined,
        },
        strength: libraryId ? "moderate" : "weak",
        detail: { tool, libraryName, libraryId, query: clip(str(input.query), 300) },
      });
    }
    return out;
  }

  return out;
}
