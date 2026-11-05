// Sign in with GitHub. A signed, HttpOnly cookie says who the person is; everything they see and do is limited to their own space.
// OPERATOR_GITHUB_LOGINS names the people who also own the server's original data and its server-wide tasks.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { config, features } from "./config.ts";
import { LOCAL_USER } from "./db.ts";
import { userById, userForGithub, type User } from "./users.ts";

const SESSION_COOKIE = "upstream_session";
const STATE_COOKIE = "upstream_oauth_state";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const STATE_SECONDS = 15 * 60;

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(`upstream-session-v2.${body}`).digest("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Exported for tests. The signing secret is ADMIN_TOKEN, so rotating that token signs everyone out. */
export function sealSession(userId: string, secret: string, exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS): string {
  const body = Buffer.from(JSON.stringify({ uid: userId, exp })).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** The user id inside a valid, unexpired cookie, or null. */
export function openSession(value: string, secret: string): string | null {
  const [body, mac, extra] = value.split(".");
  if (!body || !mac || extra !== undefined || !same(mac, sign(body, secret))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { uid?: unknown; exp?: unknown };
    if (typeof s.uid !== "string" || typeof s.exp !== "number" || s.exp <= Date.now() / 1000) return null;
    return s.uid;
  } catch {
    return null;
  }
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const cookieOptions = () => ({ httpOnly: true, sameSite: "lax" as const, secure: config.PUBLIC_BASE_URL.startsWith("https://"), path: "/" });
const redirectUri = () => `${config.PUBLIC_BASE_URL}/api/auth/github/callback`;

export const githubLoginAvailable = () => features.githubOAuth && features.admin;

export function isOperatorLogin(login: string): boolean {
  return (config.OPERATOR_GITHUB_LOGINS ?? "")
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .includes(login.toLowerCase());
}

/** Who the cookie belongs to. Removing someone from OPERATOR_GITHUB_LOGINS ends their operator session straight away. */
export function currentUser(req: Request): User | null {
  const value = cookie(req, SESSION_COOKIE);
  const uid = value && config.ADMIN_TOKEN ? openSession(value, config.ADMIN_TOKEN) : null;
  const user = uid ? userById(uid) : undefined;
  if (!user || !user.login) return null;
  if (user.id === LOCAL_USER && !isOperatorLogin(user.login)) return null;
  return user;
}

/**
 * The signed-in person this request may act for. Writes must also come from this site: the cookie is SameSite=Lax,
 * and a present Origin header has to match the host, so another website can't trigger a payout.
 */
export function sessionUser(req: Request): User | null {
  const user = currentUser(req);
  if (!user) return null;
  if (req.method === "GET" || req.method === "HEAD") return user;
  const origin = req.header("origin");
  if (!origin) return user;
  try {
    return new URL(origin).host === req.header("host") ? user : null;
  } catch {
    return null;
  }
}

export function startGithubLogin(res: Response): string {
  if (!githubLoginAvailable()) throw new Error("Sign in with GitHub isn't set up on this server yet.");
  const state = randomBytes(24).toString("hex");
  res.cookie(STATE_COOKIE, state, { ...cookieOptions(), maxAge: STATE_SECONDS * 1000 });
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", config.GITHUB_CLIENT_ID!);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("state", state);
  return u.toString();
}

export async function finishGithubLogin(req: Request, res: Response): Promise<User> {
  const expected = cookie(req, STATE_COOKIE);
  const state = String(req.query.state ?? "");
  res.clearCookie(STATE_COOKIE, cookieOptions());
  if (!expected || !state || !same(expected, state)) throw new Error("That sign-in link expired. Please try again.");
  if (req.query.error) throw new Error(String(req.query.error_description ?? "GitHub sign-in was cancelled."));

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.GITHUB_CLIENT_ID, client_secret: config.GITHUB_CLIENT_SECRET, code: String(req.query.code ?? ""), redirect_uri: redirectUri() }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!token.access_token) throw new Error(`GitHub sign-in failed: ${token.error_description ?? tokenRes.status}`);
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "upstream-oss-payouts" },
  });
  const body = (await userRes.json()) as { id?: number; login?: string; name?: string | null; avatar_url?: string | null };
  if (!userRes.ok || !body.login || !body.id) throw new Error(`GitHub didn't return your profile (HTTP ${userRes.status}).`);
  const user = userForGithub({ id: body.id, login: body.login, name: body.name ?? null, avatar_url: body.avatar_url ?? null }, isOperatorLogin(body.login));
  res.cookie(SESSION_COOKIE, sealSession(user.id, config.ADMIN_TOKEN!), { ...cookieOptions(), maxAge: SESSION_SECONDS * 1000 });
  return user;
}

export function signOut(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
