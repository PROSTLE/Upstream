// The words of an invitation to a maintainer. Plain TypeScript, so the server's tests can check them too.
import { moneyStr, plural } from "./format.ts";

export interface InviteDetails {
  repo: string;
  held: string;
  currency: string;
  expires_at: string | null;
  sessions: number;
  packages: string[];
  evidence: Record<string, number>;
  usage_lines: number;
  claim_url: string;
}

const count = (d: InviteDetails, kinds: string[]) => kinds.reduce((a, k) => a + (d.evidence[k] ?? 0), 0);

/** The body, with only numbers that exist in the records. A count of zero isn't mentioned. */
export function inviteBody(d: InviteDetails, brand: string): string {
  const facts: string[] = [];
  if (d.usage_lines > 0) facts.push(`${plural(d.usage_lines, "line")} written against its API`);
  const reads = count(d, ["source_read", "source_search", "logic_reused"]);
  if (reads > 0) facts.push(`${plural(reads, "source file")} read`);
  const docs = count(d, ["docs_fetch", "docs_mcp"]);
  if (docs > 0) facts.push(plural(docs, "docs lookup"));
  const imports = count(d, ["import_added"]);
  if (imports > 0 && d.usage_lines === 0) facts.push(`${plural(imports, "import")} written`);
  const installs = count(d, ["dep_install", "manifest_add"]);
  if (installs > 0) facts.push(plural(installs, "install"));
  const relied = facts.length ? `: ${facts.join(", ")}` : "";
  return [
    `In the last ${plural(d.sessions, "coding session")}, AI agents relied on ${d.packages.join(", ")}${relied}. ${moneyStr(d.held, d.currency)} is held for its maintainers through ${brand} and PayPal.`,
    "",
    `Claim it (sign in with GitHub, then add a PayPal account for payouts): ${d.claim_url}`,
    "",
    ...(d.expires_at ? [`Unclaimed money returns to the funder's pool on ${new Date(d.expires_at).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })}.`, ""] : []),
    "If you don't want funding this way, close this issue. Nothing else will be posted.",
  ].join("\n");
}

export const issueUrl = (repo: string, title: string, body: string) => `https://${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
