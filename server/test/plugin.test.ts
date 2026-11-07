// The Claude Code plugin manifest follows code.claude.com/docs/en/plugins-reference: every path starts with ./,
// stays inside the plugin root and exists, and the hooks file wraps its events in a top-level "hooks" key.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));

test("plugin manifest paths are relative, contained and present", () => {
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.doesNotMatch(manifest.name, /claude|anthropic/i, "reserved words");
  assert.match(manifest.hooks, /^\.\//);
  const hooksFile = path.resolve(root, manifest.hooks);
  assert.ok(hooksFile.startsWith(root) && fs.existsSync(hooksFile));
  const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.ok(hooks.hooks?.PostToolUse && hooks.hooks?.SessionStart, "events sit under the hooks wrapper");
  for (const groups of Object.values(hooks.hooks) as any[]) {
    for (const g of groups) for (const h of g.hooks) {
      const rel = h.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)?.[1];
      assert.ok(rel && fs.existsSync(path.join(root, rel)), `hook script ${rel} exists`);
    }
  }
  const mcp = manifest.mcpServers.upstream;
  assert.ok(fs.existsSync(path.join(root, mcp.args[0].replace("${CLAUDE_PLUGIN_ROOT}/", ""))));
  for (const ref of JSON.stringify(mcp).match(/\$\{user_config\.(\w+)\}/g) ?? []) {
    assert.ok(manifest.userConfig[ref.slice(14, -1)], `${ref} is declared in userConfig`);
  }
});

test("each skill has a description, and the money skill can't be invoked by the model", () => {
  for (const dir of fs.readdirSync(path.join(root, "skills"))) {
    // A Windows checkout with core.autocrlf turns these into CRLF; the repo and the published plugin keep LF.
    const md = fs.readFileSync(path.join(root, "skills", dir, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    assert.match(md, /^---\n[\s\S]*?description: .+[\s\S]*?\n---\n/, dir);
  }
  assert.match(fs.readFileSync(path.join(root, "skills", "fund", "SKILL.md"), "utf8"), /disable-model-invocation: true/);
  assert.match(fs.readFileSync(path.join(root, "skills", "statement", "SKILL.md"), "utf8"), /disable-model-invocation: true/);
});
