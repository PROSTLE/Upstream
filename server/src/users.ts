// People who sign in. Each person has a private space: their own sessions, budget, money records and payouts.
// The "local" user is the server's operator: ADMIN_TOKEN and INGEST_TOKEN act for it, and it owns all earlier data.
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { db, LOCAL_USER, newId, now } from "./db.ts";

export interface User {
  id: string;
  github_id: string | null;
  login: string | null;
  name: string | null;
  avatar_url: string | null;
  ingest_token: string | null;
}

const newToken = () => `upt_${randomBytes(32).toString("base64url")}`;

export function userById(id: string): User | undefined {
  return db().prepare("SELECT id, github_id, login, name, avatar_url, ingest_token FROM users WHERE id = ?").get(id) as User | undefined;
}

export function userIdForIngestToken(token: string): string | undefined {
  if (!token) return undefined;
  return (db().prepare("SELECT id FROM users WHERE ingest_token = ?").get(token) as { id: string } | undefined)?.id;
}

/**
 * Finds or creates the person behind a GitHub sign-in. An operator login maps to the local user, but only for the
 * GitHub account that first claimed it: GitHub frees logins after a rename, and a new owner must not inherit the operator's money.
 */
export function userForGithub(gh: { id: number; login: string; name: string | null; avatar_url: string | null }, operator: boolean): User {
  const githubId = String(gh.id);
  const d = db();
  const local = userById(LOCAL_USER)!;
  if (operator && (!local.github_id || local.github_id === githubId)) {
    d.prepare("UPDATE users SET github_id = ?, login = ?, name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?").run(githubId, gh.login, gh.name, gh.avatar_url, now(), LOCAL_USER);
    return userById(LOCAL_USER)!;
  }
  const existing = d.prepare("SELECT id FROM users WHERE github_id = ?").get(githubId) as { id: string } | undefined;
  if (existing) {
    d.prepare("UPDATE users SET login = ?, name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?").run(gh.login, gh.name, gh.avatar_url, now(), existing.id);
    return userById(existing.id)!;
  }
  const id = newId("u");
  d.prepare("INSERT INTO users(id, github_id, login, name, avatar_url, ingest_token, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)").run(id, githubId, gh.login, gh.name, gh.avatar_url, newToken(), now(), now());
  return userById(id)!;
}

/** The token this person's coding agent uses to send evidence. The operator's lives in the server's settings. */
export function ingestTokenFor(userId: string): string | null {
  return userId === LOCAL_USER ? (config.INGEST_TOKEN ?? null) : (userById(userId)?.ingest_token ?? null);
}

export function rotateIngestToken(userId: string): string {
  if (userId === LOCAL_USER) throw new Error("The operator's token is INGEST_TOKEN in the server's settings. Change it there.");
  const token = newToken();
  db().prepare("UPDATE users SET ingest_token = ? WHERE id = ?").run(token, userId);
  return token;
}
