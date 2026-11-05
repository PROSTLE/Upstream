import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");

// Load the repo-level .env once; real environment variables win.
const envFile = path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a decimal amount like 10.00");

const fraction = z.coerce.number().min(0).max(1);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_PATH: z.string().default("./data/upstream.db"),
  ADMIN_TOKEN: optional,
  INGEST_TOKEN: optional,
  // "private" (default): the operator dashboard and its API need ADMIN_TOKEN to read. "public": anyone can read
  // sessions, evidence, payouts and the ledger (for a demo). Raw hook payloads always need ADMIN_TOKEN.
  DASHBOARD_ACCESS: z.enum(["private", "public"]).default("private"),

  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_API_BASE: optional,
  PAYPAL_CLIENT_ID: optional,
  PAYPAL_CLIENT_SECRET: optional,
  PAYPAL_WEBHOOK_ID: optional,
  PAYOUT_PURPOSE: optional,
  PAYOUT_EMAIL_SUBJECT: optional,

  TITHE_AMOUNT: decimalString,
  TITHE_CURRENCY: z.string().length(3).toUpperCase(),
  TITHE_INTERVAL_UNIT: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
  TITHE_PRODUCT_NAME: z.string().min(1),
  BRAND_NAME: z.string().min(1),

  POLICY_MAX_PACKAGE_SHARE: fraction,
  POLICY_MIN_PAYOUT: decimalString,
  POLICY_MAX_PAYOUT: decimalString,
  POLICY_PAYOUT_FEE_RESERVE: fraction,
  POLICY_RESERVE_DAYS: z.coerce.number().int().positive(),
  POLICY_CANCEL_UNCLAIMED_AFTER_DAYS: z.coerce.number().int().positive(),
  // Optional. Unset POLICY_MAX_TOPUP: Upstream adds no cap of its own to one-time top-ups (PayPal's limits still apply).
  // Unset POLICY_MAX_AGENT_TOPUP: coding agents can't request top-ups at all.
  POLICY_MAX_TOPUP: optional.pipe(decimalString.optional()),
  POLICY_MAX_AGENT_TOPUP: optional.pipe(decimalString.optional()),

  MODEL_API_KEY: optional,
  // The server pays for AI reviews, so each person other than the operator gets this many per 24 hours.
  POLICY_MAX_REVIEWS_PER_DAY: z.coerce.number().int().positive().default(20),
  MODEL_API_BASE: z.string().url(),
  UPSTREAM_MODEL: z.string().min(1),
  UPSTREAM_EFFORT: z.enum(["low", "medium", "high", "xhigh"]),

  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  GITHUB_TOKEN: optional,
  // Comma-separated GitHub logins that may run the dashboard after Sign in with GitHub. Anyone else is a visitor.
  OPERATOR_GITHUB_LOGINS: optional,
  // "true" once Log in with PayPal is switched on for the PayPal app (Apps & Credentials > Other features).
  PAYPAL_LOGIN_ENABLED: optional,

  DEPSDEV_API_BASE: z.string().url(),
  ECOSYSTEMS_API_BASE: z.string().url(),
  METADATA_CACHE_HOURS: z.coerce.number().positive(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
  console.error(
    `Upstream configuration is incomplete. Copy .env.example to .env and set:\n${lines.join("\n")}`,
  );
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  PUBLIC_BASE_URL: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
  DATABASE_PATH: path.resolve(repoRoot, env.DATABASE_PATH),
  // PayPal's documented REST hosts; PAYPAL_API_BASE overrides for proxies.
  PAYPAL_API_BASE:
    env.PAYPAL_API_BASE ??
    (env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com"),
  // Log in with PayPal's authorize page (developer.paypal.com/docs/log-in-with-paypal/integrate/).
  PAYPAL_WEB_BASE: env.PAYPAL_ENV === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com",
};

export type Config = typeof config;

export const features = {
  paypal: Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET),
  llm: Boolean(config.MODEL_API_KEY),
  githubOAuth: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
  ingest: Boolean(config.INGEST_TOKEN),
  admin: Boolean(config.ADMIN_TOKEN),
  paypalLogin: Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET && config.PAYPAL_LOGIN_ENABLED === "true"),
  agentTopups: Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET && config.POLICY_MAX_AGENT_TOPUP),
};
