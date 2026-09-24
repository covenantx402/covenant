// db.js — single SQLite connection for the TRIBUTE gateway.
// Replaces the previous "read whole JSON file, mutate in memory, rewrite
// whole file" pattern used by vault/keys/wallets/sessions/reputation/
// facilitator. That pattern rewrites the ENTIRE history on every single
// mutation (a 25KB settlements.json got fully re-serialized on every paid
// call) — O(n) write cost that grows with total lifetime records, not O(1)
// per write. SQLite (WAL mode) gives indexed lookups and real O(1) inserts
// regardless of table size, plus crash-safe durability without hand-rolled
// tmp-file-then-rename dances in six different modules.
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const DB_PATH = process.env.TRIBUTE_DB_PATH || path.join(__dirname, 'data', 'gateway.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')   // concurrent readers don't block the writer
db.pragma('synchronous = NORMAL') // safe with WAL, much faster than FULL
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS vault_entries (
  name TEXT PRIMARY KEY,
  enc TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vault_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_vault_audit_t ON vault_audit(t DESC);

CREATE TABLE IF NOT EXISTS agent_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_keys(hash);

CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  vault_ref TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  payer TEXT NOT NULL,
  pay_to TEXT,
  value TEXT,
  calls_used INTEGER NOT NULL DEFAULT 0,
  calls_max INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  tx_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS reputation (
  address TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  settled_count INTEGER NOT NULL DEFAULT 0,
  total_usdg REAL NOT NULL DEFAULT 0,
  resources TEXT NOT NULL DEFAULT '{}',
  txs TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_reputation_score_inputs ON reputation(settled_count DESC, total_usdg DESC);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  tx_hash TEXT,
  t INTEGER NOT NULL,
  from_addr TEXT,
  value TEXT,
  redeemed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settlements (
  tx_hash TEXT PRIMARY KEY,
  t INTEGER NOT NULL,
  payer TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  value TEXT NOT NULL,
  value_formatted TEXT NOT NULL,
  resource TEXT,
  gas_used TEXT,
  pending_splits TEXT,
  splits TEXT,
  splits_cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_settlements_t ON settlements(t DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_payer ON settlements(payer);

-- Prepaid buyer balances (was JSON-file-per-mutation in balance.js — same
-- full-rewrite cost problem the rest of this file was migrated off of, and
-- the one ledger holding actual escrowed USDG).
CREATE TABLE IF NOT EXISTS balances (
  address TEXT PRIMARY KEY,
  balance_atomic TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS balance_keys (
  hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_balance_keys_address ON balance_keys(address);

CREATE TABLE IF NOT EXISTS balance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  type TEXT NOT NULL,
  amount TEXT NOT NULL,
  note TEXT,
  t INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balance_history_address ON balance_history(address, t DESC);

-- Paid-route registry (was routes.json, rewritten whole-file on every 402
-- hit via x402-routes.js log()). Same migration as above.
CREATE TABLE IF NOT EXISTS routes (
  slug TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  price TEXT NOT NULL,
  description TEXT,
  pay_to TEXT,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS route_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  slug TEXT,
  path TEXT,
  price TEXT,
  status INTEGER,
  network TEXT
);
CREATE INDEX IF NOT EXISTS idx_route_activity_t ON route_activity(t DESC);

-- Rate-limit buckets (was pure in-memory — reset to zero on every restart,
-- including the 5/hour guard on the open POST /keys endpoint).
CREATE TABLE IF NOT EXISTS ratelimit_buckets (
  bucket TEXT PRIMARY KEY,
  hits TEXT NOT NULL
);
`)

module.exports = db
