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

  ANTHROPIC_API_KEY: optional,
  UPSTREAM_MODEL: z.string().min(1),
  UPSTREAM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]),

  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  GITHUB_TOKEN: optional,

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
};

export type Config = typeof config;

export const features = {
  paypal: Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET),
  llm: Boolean(config.ANTHROPIC_API_KEY),
  githubOAuth: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
  ingest: Boolean(config.INGEST_TOKEN),
  admin: Boolean(config.ADMIN_TOKEN),
};
