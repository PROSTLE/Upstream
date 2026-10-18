import "./helpers/env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepoInput } from "../src/claims.ts";

test("repo input accepts owner/name and github.com URLs, and nothing else", () => {
  assert.equal(parseRepoInput("colinhacks/zod"), "github.com/colinhacks/zod");
  assert.equal(parseRepoInput(" https://github.com/Vercel/next.js/tree/canary "), "github.com/vercel/next.js");
  assert.equal(parseRepoInput("git@github.com:a-b/c.git"), "github.com/a-b/c");
  for (const bad of ["zod", "gitlab.com/a/b", "https://gitlab.com/a/b", ""]) assert.throws(() => parseRepoInput(bad), /GitHub repository/, bad);
});
