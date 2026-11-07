import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

/** The server's operator: ADMIN_TOKEN and INGEST_TOKEN act for this user, and it owns everything recorded before people had their own space. */
export const LOCAL_USER = "local";

// Throwaway owners of public /check runs. They never count in anything shown across people, and can never be paid out.
export const CHECK_USER_PREFIX = "check_";
export const isCheckUser = (userId: string) => userId.startsWith(CHECK_USER_PREFIX);
export const NOT_CHECK_USER = "user_id NOT LIKE 'check\\_%' ESCAPE '\\'";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- People who sign in. Sessions, budgets, money records and payouts each belong to one of them.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  login TEXT,
  name TEXT,
  avatar_url TEXT,
  ingest_token TEXT UNIQUE,                     -- what this person's coding agent sends evidence with
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One Claude Code session (identified by the hook's session_id).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT,
  project TEXT,
  transcript_path TEXT,
  started_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- open | closed | attributed
  manifest_json TEXT,                           -- latest manifest snapshot from the hook
  py_import_map_json TEXT,                      -- importlib.metadata.packages_distributions()
  allocated_settlement_id TEXT
);

-- Raw hook payloads, exactly as received (truncated fields are marked).
CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  hook_event_name TEXT NOT NULL,
  tool_name TEXT,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

-- Deterministic evidence derived from hook events.
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,                          -- e.g. ev_12_3 (event id, ordinal)
  session_id TEXT NOT NULL REFERENCES sessions(id),
  hook_event_id INTEGER NOT NULL REFERENCES hook_events(id),
  kind TEXT NOT NULL,
  ecosystem TEXT,
  package TEXT,                                 -- normalized package name when known
  hint TEXT,                                    -- url / repo / library id when package unknown yet
  strength TEXT NOT NULL,                       -- strong | moderate | weak
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_session ON evidence(session_id);

CREATE TABLE IF NOT EXISTS attribution_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  method TEXT NOT NULL,                         -- llm | baseline | manifest (equal split of the dependency list, for comparison only, never paid)
  model TEXT,
  candidates_json TEXT NOT NULL,
  raw_output_json TEXT,
  validated_json TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  usage_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 0
);

-- Human labels for the attribution eval.
CREATE TABLE IF NOT EXISTS labels (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  label TEXT NOT NULL,                          -- meaningful | incidental | not_used
  weight REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, ecosystem, package)
);

CREATE TABLE IF NOT EXISTS packages (
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,                                    -- github.com/owner/repo
  repo_provenance TEXT,                         -- deps.dev relationProvenance or 'ecosyste.ms'
  homepage TEXT,
  documentation_url TEXT,
  registry_url TEXT,
  funding_links_json TEXT,
  funding_yml_json TEXT,
  sources_json TEXT,
  resolved_at TEXT,
  resolve_error TEXT,
  PRIMARY KEY (ecosystem, name)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  method TEXT NOT NULL,                         -- github_admin | funding_yml_token
  github_login TEXT,
  token TEXT UNIQUE,
  paypal_receiver TEXT,
  receiver_type TEXT NOT NULL DEFAULT 'EMAIL',
  status TEXT NOT NULL,                         -- pending | verified | revoked | receiver_unclaimed
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS claims_repo ON claims(repo);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,                          -- PayPal subscription id
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  subscriber_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT
);

-- Money movements. Positive = into the pool, negative = out.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- FUNDING_GROSS | FUNDING_FEE | PAYOUT_SENT | PAYOUT_FEE | PAYOUT_RETURNED
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  memo TEXT,
  source TEXT NOT NULL                          -- webhook | api_sync
);

-- Allocations = earmarks inside the pool for a repo, not money movements.
CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL,
  repo TEXT,
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,                         -- planned | reserved | in_batch | paid | released
  target TEXT NOT NULL DEFAULT 'payout',        -- what a planned allocation becomes on approval: payout | reserve
  payout_item_ref TEXT,
  session_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                         -- draft | approved | sending | sent | failed | empty
  currency TEXT NOT NULL,
  pool_minor INTEGER NOT NULL,
  planned_minor INTEGER NOT NULL,
  reserved_minor INTEGER NOT NULL,
  fee_reserve_minor INTEGER NOT NULL,
  sender_batch_id TEXT UNIQUE,
  request_json TEXT,
  payout_batch_id TEXT,
  batch_status TEXT,
  batch_fee_minor INTEGER,
  policy_json TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  sent_at TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS payout_items (
  sender_item_id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  claim_id TEXT NOT NULL REFERENCES claims(id),
  repo TEXT NOT NULL,
  receiver TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  note TEXT NOT NULL,
  allocation_ids_json TEXT NOT NULL,
  payout_item_id TEXT UNIQUE,
  transaction_id TEXT,
  transaction_status TEXT,
  fee_minor INTEGER,
  errors_json TEXT,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,                          -- PayPal event id
  event_type TEXT NOT NULL,
  resource_type TEXT,
  received_at TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  processed_at TEXT,
  process_error TEXT,
  raw_json TEXT NOT NULL
);

-- One-time top-ups through PayPal Orders v2 (intent CAPTURE). Money is booked only from the capture PayPal returns.
CREATE TABLE IF NOT EXISTS topups (
  id TEXT PRIMARY KEY,                          -- also the order's custom_id and PayPal-Request-Id
  order_id TEXT UNIQUE,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL,                         -- dashboard | agent
  note TEXT,
  status TEXT NOT NULL,                         -- order status: CREATED | APPROVED | COMPLETED | VOIDED | PAYER_ACTION_REQUIRED
  capture_id TEXT,
  capture_status TEXT,                          -- COMPLETED | PENDING | DECLINED | REFUNDED | PARTIALLY_REFUNDED | FAILED
  approve_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Log in with PayPal round trips for maintainers (state -> what the sign-in completes).
CREATE TABLE IF NOT EXISTS paypal_login_states (
  state TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                           -- github_claim | funding_claim
  repo TEXT,
  claim_token TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);

-- Every call Upstream makes to PayPal, for the audit trail in the dashboard.
CREATE TABLE IF NOT EXISTS paypal_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_id TEXT,
  status INTEGER,
  debug_id TEXT,
  duration_ms INTEGER,
  error_name TEXT
);

-- Public /check runs. Each belongs to a throwaway user and is deleted, with everything under it, at expires_at.
CREATE TABLE IF NOT EXISTS public_checks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL,                        -- sha256(ip + server secret), only used to count requests
  llm_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',       -- running | done | failed
  ai_state TEXT NOT NULL,                       -- running | done | paused | off | failed
  file_name TEXT,
  stats_json TEXT,
  warnings_json TEXT
);
CREATE INDEX IF NOT EXISTS public_checks_expires ON public_checks(expires_at);
CREATE INDEX IF NOT EXISTS public_checks_ip ON public_checks(ip_hash, created_at);

-- Every money movement, for the live diagram. Only what PayPal confirmed, or Upstream's own holds (labelled as such). Never an email address.
CREATE TABLE IF NOT EXISTS money_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                           -- ledger | payout_status | batch | earmark
  at TEXT NOT NULL,                             -- when it happened (ledger occurred_at, PayPal time, or now)
  created_at TEXT NOT NULL,
  from_node TEXT,                               -- both null: shown in the event list, not animated
  to_node TEXT,
  amount_minor INTEGER NOT NULL,                -- always positive; direction comes from from_node and to_node
  currency TEXT NOT NULL,
  label TEXT NOT NULL,                          -- one plain sentence
  kind TEXT,
  ref_type TEXT,
  ref_id TEXT,
  settlement_id TEXT,
  repo TEXT,
  status_from TEXT,
  status_to TEXT,
  paypal_ids_json TEXT,                         -- {transaction_id, payout_item_id, payout_batch_id, capture_id, order_id, subscription_id} when known
  trigger_json TEXT NOT NULL,                   -- {via:"webhook", event_id, event_type, verified:true} | {via:"api", action} | {via:"none"}
  backfilled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS money_events_user ON money_events(user_id, id);

-- Who told a maintainer about held money. A person always does the telling; this only remembers that they did.
CREATE TABLE IF NOT EXISTS invites (
  repo TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  channel TEXT NOT NULL,                        -- github_issue | copied_text | copied_link
  PRIMARY KEY (repo, user_id)
);

-- Monthly funding statements, issued as PayPal invoices. One per person per month.
CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,                          -- YYYY-MM
  invoice_id TEXT,
  status TEXT NOT NULL,                         -- CREATING until PayPal answers, then PayPal's own invoice status
  view_url TEXT,
  recipient TEXT,
  user_note TEXT,
  payments_json TEXT NOT NULL DEFAULT '[]',     -- [{transaction_id, method}]: method OTHER means PayPal turned down its own id for this invoice
  created_at TEXT NOT NULL,
  UNIQUE (user_id, month)
);
`;

// Everything a person owns. Packages and maintainer claims stay shared: a maintainer verifies once, for everyone.
const OWNED_TABLES = ["sessions", "subscriptions", "ledger", "allocations", "settlements", "topups", "paypal_calls"];

function migrate(d: DatabaseSync) {
  for (const table of OWNED_TABLES) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "user_id")) d.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LOCAL_USER}'`);
    d.exec(`CREATE INDEX IF NOT EXISTS ${table}_user ON ${table}(user_id)`);
  }
  // Where a session's events came from: "hook" (live) or "transcript" (imported from a session file).
  const sessionCols = d.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "source")) d.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'hook'");
  // How each PayPal call was made: "sdk" (PayPal's Server SDK, generated by APIMatic) or "rest" (a direct call). Older rows were all direct.
  const callCols = d.prepare("PRAGMA table_info(paypal_calls)").all() as { name: string }[];
  if (!callCols.some((c) => c.name === "client")) d.exec("ALTER TABLE paypal_calls ADD COLUMN client TEXT NOT NULL DEFAULT 'rest'");
  d.prepare("INSERT OR IGNORE INTO users(id, created_at) VALUES (?, ?)").run(LOCAL_USER, now());
}

let instance: DatabaseSync | undefined;

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function db(): DatabaseSync {
  if (!instance) throw new Error("Database not initialised");
  return instance;
}

export function initDb(file: string): DatabaseSync {
  instance = openDb(file);
  return instance;
}

export function setDbForTests(d: DatabaseSync): void {
  instance = d;
}

export const now = () => new Date().toISOString();

export function getSetting(key: string): string | undefined {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, now());
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
