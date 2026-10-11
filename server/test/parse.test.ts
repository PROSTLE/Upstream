import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addedManifestDeps,
  dependencyFromPath,
  depsFromPyproject,
  hintFromUrl,
  parseCommand,
  parseJsImports,
  parsePyImports,
  usageLines,
} from "../src/evidence/parse.ts";
import { extractEvidence } from "../src/evidence/extract.ts";

test("JS imports: packages, scopes, builtins and relative paths", () => {
  const code = `
import { z } from "zod";
import type { Foo } from "@scope/types/sub";
import * as path from "node:path";
import fs from "fs";
import local from "./local";
import "@/alias";
const express = require("express");
const { parse } = require('yaml');
export { x } from "lodash/fp";
`;
  const got = parseJsImports(code).map((i) => [i.module, i.bindings.join(","), i.typeOnly]);
  assert.deepEqual(got, [
    ["zod", "z", false],
    ["@scope/types", "Foo", true],
    ["express", "express", false],
    ["yaml", "parse", false],
    ["lodash", "", false],
  ]);
});

test("Python imports keep the top-level module and aliases", () => {
  const got = parsePyImports("import numpy as np\nfrom sklearn.linear_model import LinearRegression as LR\nfrom . import sibling\nimport os, requests\n");
  assert.deepEqual(got.map((i) => [i.module, i.bindings]), [
    ["numpy", ["np"]],
    ["os", ["os"]],
    ["requests", ["requests"]],
    ["sklearn", ["LR"]],
  ]);
});

test("usage lines ignore import lines and member access of other objects", () => {
  const code = `import { z } from "zod";\nconst A = z.object({ a: z.string() });\nfoo.z = 1;\nconst b = 2;`;
  assert.equal(usageLines(code, ["z"]), 1);
});

test("install commands across package managers", () => {
  const got = parseCommand("npm i -D vitest@^2 && pnpm add @tanstack/react-query; pip install 'requests[socks]>=2' -r req.txt && uv add Pydantic_Core && npx prisma migrate dev && python -m pip install httpx");
  assert.deepEqual(got.map((c) => [c.ecosystem, c.package, c.kind]), [
    ["npm", "vitest", "dep_install"],
    ["npm", "@tanstack/react-query", "dep_install"],
    ["pypi", "requests", "dep_install"],
    ["pypi", "pydantic-core", "dep_install"],
    ["npm", "prisma", "cli_run"],
    ["pypi", "httpx", "dep_install"],
  ]);
});

test("manifest edits only count newly added dependencies", () => {
  const before = `"dependencies": {\n  "react": "^19.0.0"\n}`;
  const after = `"dependencies": {\n  "react": "^19.0.0",\n  "zod": "^4.0.0"\n},\n"scripts": { "build": "vite build" }`;
  assert.deepEqual(addedManifestDeps("package.json", before, after), ["zod"]);
  assert.deepEqual(addedManifestDeps("requirements.txt", "flask==3.0\n", "flask==3.0\nSQLAlchemy>=2\n"), ["sqlalchemy"]);
});

test("pyproject dependencies (PEP 621 and poetry)", () => {
  const toml = `[project]\ndependencies = ["fastapi>=0.110", "uvicorn[standard]"]\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "^13"\n`;
  assert.deepEqual(depsFromPyproject(toml).sort(), ["fastapi", "rich", "uvicorn"]);
});

test("dependency source paths and doc URLs", () => {
  assert.deepEqual(dependencyFromPath("C:\\proj\\node_modules\\@scope\\pkg\\dist\\index.js"), { ecosystem: "npm", module: "@scope/pkg" });
  assert.deepEqual(dependencyFromPath("/venv/lib/python3.12/site-packages/requests/api.py"), { ecosystem: "pypi", module: "requests" });
  assert.equal(hintFromUrl("https://www.npmjs.com/package/@hono/node-server")?.package, "@hono/node-server");
  assert.equal(hintFromUrl("https://github.com/colinhacks/zod/blob/main/README.md")?.repo, "github.com/colinhacks/zod");
  assert.equal(hintFromUrl("https://zod.dev/api")?.host, "zod.dev");
});

test("PostToolUse Edit: new import with usage is strong, existing import usage is api_usage", () => {
  const ev = extractEvidence({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: "/p/src/a.ts",
      old_string: "export const x = 1;",
      new_string: `import { z } from "zod";\nexport const S = z.object({ a: z.string() });\nexport const y = dayjs().format();`,
    },
    upstream: { file_head: `import dayjs from "dayjs";\nimport { z } from "zod";` },
  });
  assert.deepEqual(ev.map((e) => [e.kind, e.module, e.strength]), [
    ["import_added", "zod", "strong"],
    ["api_usage", "dayjs", "moderate"],
  ]);
});

test("Context7 MCP lookups become docs_mcp hints", () => {
  const ev = extractEvidence({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__context7__query-docs",
    tool_input: { libraryId: "/vercel/next.js", query: "app router caching" },
  });
  assert.equal(ev[0].kind, "docs_mcp");
  assert.equal(ev[0].hint?.repo, "github.com/vercel/next.js");
});
