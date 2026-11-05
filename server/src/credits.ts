// "Open-source credits" for a pull request, from a session's active (validated) attribution.
// Shared by the dashboard's copy button and the agent's MCP tool so both say exactly the same thing.
import { activeRun } from "./attribution/run.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";

const pct = (w: number) => `${(w * 100).toFixed(w < 0.1 ? 1 : 0)}%`;
const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function sessionCredits(sessionId: string): { markdown: string; packages: number } | undefined {
  const run = activeRun(sessionId);
  if (!run) return undefined;
  const paid = run.validated.weights.filter((w) => w.weight > 0);
  const repoOf = (eco: string, name: string) =>
    run.candidates.candidates?.find((c) => c.ecosystem === eco && c.name === name)?.repo ??
    (db().prepare("SELECT repo FROM packages WHERE ecosystem = ? AND name = ?").get(eco, name) as { repo: string | null } | undefined)?.repo ??
    null;
  const lines = ["#### Open-source credits", ""];
  if (!paid.length) {
    lines.push("Written with an AI coding agent. No package had evidence of real use in this session.");
  } else {
    lines.push("Written with an AI coding agent. Evidence from the session shows it relied on:", "", "| Package | Role | Share | Why |", "|---|---|---|---|");
    for (const w of paid) {
      const repo = repoOf(w.ecosystem, w.name);
      const name = repo ? `[${w.name}](https://${repo})` : `\`${w.name}\``;
      lines.push(`| ${name} | ${w.classification.replace("_", " ")} | ${pct(w.weight)} | ${cell(w.rationale || "—")} |`);
    }
    if (run.validated.unallocated > 0.0001) lines.push("", `${pct(run.validated.unallocated)} of the session's share went to no package (per-package cap or nothing qualified).`);
  }
  lines.push("", `<sub>Measured by ${config.BRAND_NAME} from the agent's tool calls${run.method === "llm" ? ", weighed by Muse Spark and checked by code" : " with the import-count baseline"}. Maintainers who verify their repo are paid through PayPal.</sub>`);
  return { markdown: lines.join("\n"), packages: paid.length };
}
