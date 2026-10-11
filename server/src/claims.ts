// Maintainer claims. A claim only becomes payable after ownership is proven:
//  - github_admin: GitHub OAuth, then GET /repos/{owner}/{repo} must report permissions.admin or .maintain
//  - funding_yml_token: a token we issue must appear in the repo's FUNDING.yml on the default branch
import { randomBytes } from "node:crypto";
import { config, features } from "./config.ts";
import { db, json, newId, now, tx } from "./db.ts";
import { fetchFundingYml, normalizeRepo } from "./resolve/index.ts";

export interface Claim {
  id: string;
  repo: string;
  method: "github_admin" | "funding_yml_token";
  github_login: string | null;
  token: string | null;
  paypal_receiver: string | null;
  receiver_type: string;
  status: "pending" | "verified" | "superseded" | "receiver_unclaimed" | "revoked";
  evidence: Record<string, unknown>;
  created_at: string;
  verified_at: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRepoInput(input: string): string {
  const repo = normalizeRepo(input.includes("github.com") ? input : `https://github.com/${input}`);
  if (!repo) throw new Error("Enter a GitHub repository as owner/name or a github.com URL.");
  return repo;
}

function rowToClaim(r: any): Claim {
  return { ...r, evidence: json(r.evidence_json, {}) };
}

export function listClaims(): Claim[] {
  return (db().prepare("SELECT * FROM claims ORDER BY created_at DESC").all() as any[]).map(rowToClaim);
}

/** The single payable claim for a repo, if any. */
export function payableClaim(repo: string): Claim | undefined {
  const r = db()
    .prepare("SELECT * FROM claims WHERE repo = ? AND status = 'verified' AND paypal_receiver IS NOT NULL ORDER BY verified_at DESC LIMIT 1")
    .get(repo);
  return r ? rowToClaim(r) : undefined;
}

function activate(claimId: string, repo: string) {
  tx(() => {
    db().prepare("UPDATE claims SET status = 'superseded' WHERE repo = ? AND status IN ('verified','receiver_unclaimed') AND id != ?").run(repo, claimId);
    db().prepare("UPDATE claims SET status = 'verified', verified_at = ? WHERE id = ?").run(now(), claimId);
  });
}

// ---------- GitHub OAuth ----------

export function githubAuthorizeUrl(repoInput: string): string {
  if (!features.githubOAuth) throw new Error("GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).");
  const repo = parseRepoInput(repoInput);
  const state = randomBytes(24).toString("hex");
  db().prepare("INSERT INTO oauth_states(state, repo, created_at) VALUES (?,?,?)").run(state, repo, now());
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", config.GITHUB_CLIENT_ID!);
  u.searchParams.set("redirect_uri", `${config.PUBLIC_BASE_URL}/api/claims/github/callback`);
  u.searchParams.set("scope", "read:org");
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

export async function githubCallback(code: string, state: string): Promise<{ claimId: string; token: string; repo: string }> {
  const st = db().prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as
    | { repo: string; created_at: string; used_at: string | null }
    | undefined;
  if (!st || st.used_at) throw new Error("This sign-in link is invalid or was already used.");
  if (Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) throw new Error("This sign-in link expired. Start again.");
  db().prepare("UPDATE oauth_states SET used_at = ? WHERE state = ?").run(now(), state);

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${config.PUBLIC_BASE_URL}/api/claims/github/callback`,
    }),
  });
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!tokenBody.access_token) throw new Error(`GitHub sign-in failed: ${tokenBody.error_description ?? tokenRes.status}`);
  const gh = (path: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "upstream-oss-payouts",
      },
    });
  const userRes = await gh("/user");
  const user = (await userRes.json()) as { login?: string; id?: number };
  const [, owner, name] = st.repo.split("/");
  const repoRes = await gh(`/repos/${owner}/${name}`);
  if (repoRes.status !== 200) throw new Error(`GitHub could not show ${st.repo} to @${user.login} (HTTP ${repoRes.status}).`);
  const repoBody = (await repoRes.json()) as {
    full_name: string;
    permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
    archived?: boolean;
  };
  const perms = repoBody.permissions ?? {};
  if (!perms.admin && !perms.maintain) {
    throw new Error(`@${user.login} does not have admin or maintain permission on ${repoBody.full_name}. Ask a repo admin to claim it.`);
  }
  const token = randomBytes(24).toString("hex");
  const claimId = newId("clm");
  db()
    .prepare(
      "INSERT INTO claims(id, repo, method, github_login, token, status, evidence_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      claimId,
      st.repo,
      "github_admin",
      user.login ?? null,
      token,
      "pending",
      JSON.stringify({ github_user_id: user.id, full_name: repoBody.full_name, permissions: perms, checked_at: now() }),
      now(),
    );
  return { claimId, token, repo: st.repo };
}

export function completeGithubClaim(token: string, receiver: string): Claim {
  if (!EMAIL.test(receiver)) throw new Error("Enter the email address of your PayPal account.");
  const row = db().prepare("SELECT * FROM claims WHERE token = ? AND method = 'github_admin'").get(token) as any;
  if (!row) throw new Error("Unknown claim.");
  if (row.status !== "pending") throw new Error("This claim is already complete.");
  db().prepare("UPDATE claims SET paypal_receiver = ?, receiver_type = 'EMAIL' WHERE id = ?").run(receiver.trim(), row.id);
  activate(row.id, row.repo);
  return rowToClaim(db().prepare("SELECT * FROM claims WHERE id = ?").get(row.id));
}

// ---------- FUNDING.yml token ----------

export function startFundingTokenClaim(repoInput: string, receiver: string): Claim & { instruction: string } {
  if (!EMAIL.test(receiver)) throw new Error("Enter the email address of your PayPal account.");
  const repo = parseRepoInput(repoInput);
  const token = `upc_${randomBytes(12).toString("hex")}`;
  const id = newId("clm");
  db()
    .prepare("INSERT INTO claims(id, repo, method, token, paypal_receiver, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, repo, "funding_yml_token", token, receiver.trim(), "pending", now());
  const claim = rowToClaim(db().prepare("SELECT * FROM claims WHERE id = ?").get(id));
  return {
    ...claim,
    instruction: `custom: ["${config.PUBLIC_BASE_URL}/c/${token}"]`,
  };
}

export async function verifyFundingTokenClaim(claimId: string): Promise<Claim> {
  const row = db().prepare("SELECT * FROM claims WHERE id = ? AND method = 'funding_yml_token'").get(claimId) as any;
  if (!row) throw new Error("Unknown claim.");
  const yml = await fetchFundingYml(row.repo);
  if (!yml) throw new Error(`No FUNDING.yml found in ${row.repo} (.github/, root or docs/).`);
  if (!yml.raw.includes(row.token)) {
    throw new Error(`FUNDING.yml in ${row.repo} (${yml.path}) does not contain ${row.token} yet. Commit it to the default branch and retry.`);
  }
  db()
    .prepare("UPDATE claims SET evidence_json = ? WHERE id = ?")
    .run(JSON.stringify({ funding_yml_path: yml.path, found_token: row.token, checked_at: now() }), row.id);
  activate(row.id, row.repo);
  return rowToClaim(db().prepare("SELECT * FROM claims WHERE id = ?").get(row.id));
}

export function claimByToken(token: string): Claim | undefined {
  const r = db().prepare("SELECT * FROM claims WHERE token = ?").get(token);
  return r ? rowToClaim(r) : undefined;
}

export function markReceiverUnclaimed(claimId: string) {
  db().prepare("UPDATE claims SET status = 'receiver_unclaimed' WHERE id = ? AND status = 'verified'").run(claimId);
}

/**
 * Only GitHub-verified claims can change their receiver with their private token.
 * FUNDING.yml tokens are public by design, so those maintainers re-claim instead.
 */
export function updateReceiver(claimId: string, receiver: string, proofToken: string): Claim {
  if (!EMAIL.test(receiver)) throw new Error("Enter the email address of your PayPal account.");
  const row = db()
    .prepare("SELECT * FROM claims WHERE id = ? AND token = ? AND method = 'github_admin'")
    .get(claimId, proofToken) as any;
  if (!row) throw new Error("Unknown claim or token. FUNDING.yml claims change their receiver by claiming again.");
  db().prepare("UPDATE claims SET paypal_receiver = ? WHERE id = ?").run(receiver.trim(), claimId);
  activate(claimId, row.repo);
  return rowToClaim(db().prepare("SELECT * FROM claims WHERE id = ?").get(claimId));
}
