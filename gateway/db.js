// db.js — single SQLite connection for the COVENANT gateway.
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

const DB_PATH = process.env.COVENANT_DB_PATH || path.join(__dirname, 'data', 'gateway.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')   // concurrent readers don't block the writer
db.pragma('synchronous = NORMAL') // safe with WAL, much faster than FULL
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS vault_entries (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  enc TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, name)
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
  owner TEXT NOT NULL,
  label TEXT NOT NULL,
  vault_ref TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL DEFAULT 4663,
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
  chain_id INTEGER NOT NULL DEFAULT 4663,
  nonce TEXT NOT NULL,
  tx_hash TEXT,
  t INTEGER NOT NULL,
  from_addr TEXT,
  value TEXT,
  redeemed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, nonce)
);
-- Composite PK matters: EIP-712 domain includes chainId, so the same nonce
-- VALUE signed for two different chains produces two different (valid)
-- signatures — they must not collide in the replay-guard table. A nonce
-- unique only by its raw bytes would reject the second chain's legitimate
-- payment as "already used".

CREATE TABLE IF NOT EXISTS settlements (
  chain_id INTEGER NOT NULL DEFAULT 4663,
  tx_hash TEXT NOT NULL,
  t INTEGER NOT NULL,
  payer TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  value TEXT NOT NULL,
  value_formatted TEXT NOT NULL,
  resource TEXT,
  gas_used TEXT,
  pending_splits TEXT,
  splits TEXT,
  splits_cancelled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, tx_hash)
);
-- tx_hash alone is already unique in practice (256-bit hash), but the
-- composite key keeps this table consistent with nonces/sessions and makes
-- "settlements on chain X" a plain indexed lookup instead of a WHERE scan.
CREATE INDEX IF NOT EXISTS idx_settlements_t ON settlements(t DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_payer ON settlements(payer);
-- idx_settlements_chain is created after the migration block below, once
-- chain_id is guaranteed to exist (a fresh DB gets it from CREATE TABLE
-- above; an upgraded DB gets it from the ALTER/rebuild migration).

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

-- Marketplace: third-party paid API listings (was marketplace.json,
-- full-file rewrite on every hit/settle/refund — the last flat-file module
-- in the gateway). Lower risk than balances/routes (no direct USDG here,
-- escrow money moves through facilitator.js/settlements which were already
-- SQLite), but same durability/perf problem under load.
CREATE TABLE IF NOT EXISTS marketplace_listings (
  slug TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  upstream TEXT NOT NULL,
  price TEXT NOT NULL,
  seller TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delisted_at INTEGER,
  hits INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0,
  earned_atomic TEXT NOT NULL DEFAULT '0',
  refunded_atomic TEXT NOT NULL DEFAULT '0',
  lat_sum_ms INTEGER NOT NULL DEFAULT 0,
  lat_n INTEGER NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  plan_calls INTEGER,
  plan_price TEXT,
  plan_atomic TEXT,
  private_headers_enc TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_seller ON marketplace_listings(seller);

CREATE TABLE IF NOT EXISTS marketplace_subs (
  slug TEXT NOT NULL,
  buyer TEXT NOT NULL,
  plan_calls INTEGER NOT NULL,
  plan_price TEXT NOT NULL,
  atomic TEXT NOT NULL,
  remaining INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  purchased_at INTEGER NOT NULL,
  tx_hash TEXT,
  PRIMARY KEY (slug, buyer)
);

CREATE TABLE IF NOT EXISTS marketplace_nonces (
  nonce TEXT PRIMARY KEY,
  t INTEGER NOT NULL
);

-- x402 "batch-settlement" scheme: off-chain-verified vouchers accumulated
-- into ONE on-chain settlement instead of one settlement per request.
-- Explicitly NOT a full bidirectional payment channel contract (no
-- on-chain escrow deposit, no non-cooperative-withdraw dispute timer like
-- CDP's channel spec) — it's a simpler "running tab" on top of the same
-- approve+transferFrom pattern every other route here uses: the buyer's
-- safety valve is revoking the ERC-20 approval, not an on-chain challenge
-- period. See batch.js for the honest framing.
CREATE TABLE IF NOT EXISTS batch_channels (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  payer TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  valid_before INTEGER NOT NULL,
  last_cumulative_value TEXT NOT NULL DEFAULT '0',
  last_nonce TEXT,
  vouchers_verified INTEGER NOT NULL DEFAULT 0,
  claimed_value TEXT NOT NULL DEFAULT '0',
  claimed_tx_hashes TEXT NOT NULL DEFAULT '[]',
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_batch_channels_payer ON batch_channels(payer);
`)

// --- Migration: add chain_id to tables that predate multichain support ---
// CREATE TABLE IF NOT EXISTS above is a no-op on a DB that already has these
// tables from before this change (production has real nonces/settlements
// history) — it does NOT alter existing schema. Handle that explicitly:
// nonces/settlements need a PK change (single-column -> composite), which
// SQLite can't ALTER in place, so those get a rebuild-and-copy. sessions
// only gained a plain column, which SQLite CAN add in place.
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)
}

if (!hasColumn('nonces', 'chain_id')) {
  // SQLite DDL is transactional. Run the rename → rebuild → copy → drop in
  // ONE better-sqlite3 transaction, never as a sequence of autocommit DDL.
  // If the process dies or any statement fails, rollback leaves the exact
  // legacy nonces table intact — no window where replay protection can
  // silently become an empty new table while history sits in a renamed one.
  db.transaction(() => {
    db.exec(`
      ALTER TABLE nonces RENAME TO nonces_pre_multichain;
      CREATE TABLE nonces (
        chain_id INTEGER NOT NULL DEFAULT 4663,
        nonce TEXT NOT NULL,
        tx_hash TEXT,
        t INTEGER NOT NULL,
        from_addr TEXT,
        value TEXT,
        redeemed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chain_id, nonce)
      );
      INSERT INTO nonces (chain_id, nonce, tx_hash, t, from_addr, value, redeemed)
        SELECT 4663, nonce, tx_hash, t, from_addr, value, redeemed FROM nonces_pre_multichain;
      DROP TABLE nonces_pre_multichain;
    `)
  })()
  console.log('[db] migrated nonces -> composite (chain_id, nonce) primary key')
}

// --- Security hardening migrations (audit 2026-10) ---
// nonces.pending: JSON of a broadcast-but-unconfirmed transferFrom, so the
// nonce is NEVER released while a tx may still land (see facilitator.settle).
if (!hasColumn('nonces', 'pending')) db.exec('ALTER TABLE nonces ADD COLUMN pending TEXT')
// Canonicalise legacy nonce casing (replay guard now keys on lowercase). OR IGNORE: if both casings
// exist, the already-lowercase row is kept.
db.exec("UPDATE OR IGNORE nonces SET nonce = lower(nonce) WHERE nonce != lower(nonce)")
// batch_channels.claim_lock: DB-backed (multi-process, restart-safe) claim lock.
// batch_channels.claim_pending: JSON of a broadcast-but-unrecorded claim.
if (!hasColumn('batch_channels', 'claim_lock')) db.exec('ALTER TABLE batch_channels ADD COLUMN claim_lock INTEGER')
if (!hasColumn('batch_channels', 'claim_pending')) db.exec('ALTER TABLE batch_channels ADD COLUMN claim_pending TEXT')

if (!hasColumn('settlements', 'chain_id')) {
  // Same atomic migration guarantee for settlement history — this table is
  // financial/audit evidence, so a partial rebuild is unacceptable.
  db.transaction(() => {
    db.exec(`
      ALTER TABLE settlements RENAME TO settlements_pre_multichain;
      CREATE TABLE settlements (
        chain_id INTEGER NOT NULL DEFAULT 4663,
        tx_hash TEXT NOT NULL,
        t INTEGER NOT NULL,
        payer TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        value TEXT NOT NULL,
        value_formatted TEXT NOT NULL,
        resource TEXT,
        gas_used TEXT,
        pending_splits TEXT,
        splits TEXT,
        splits_cancelled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chain_id, tx_hash)
      );
      INSERT INTO settlements (chain_id, tx_hash, t, payer, pay_to, value, value_formatted, resource, gas_used, pending_splits, splits, splits_cancelled)
        SELECT 4663, tx_hash, t, payer, pay_to, value, value_formatted, resource, gas_used, pending_splits, splits, splits_cancelled FROM settlements_pre_multichain;
      DROP TABLE settlements_pre_multichain;
      CREATE INDEX IF NOT EXISTS idx_settlements_t ON settlements(t DESC);
      CREATE INDEX IF NOT EXISTS idx_settlements_payer ON settlements(payer);
      CREATE INDEX IF NOT EXISTS idx_settlements_chain ON settlements(chain_id);
    `)
  })()
  console.log('[db] migrated settlements -> composite (chain_id, tx_hash) primary key')
}

if (!hasColumn('sessions', 'chain_id')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;`)
  console.log('[db] migrated sessions -> added chain_id column')
}

// Legacy wallets have no owner. Owner '' matches no authenticated key, so
// they stay in place (nothing deleted) and are hidden from every API caller.
if (!hasColumn('wallets', 'owner')) {
  db.exec("ALTER TABLE wallets ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
  console.log('[db] wallets: added owner column; legacy wallets are unowned')
}

// --- Migration: scope vault_entries per owner (agent key id) ---
// Legacy rows have no owner and cannot be attributed to any key. They are
// kept (still encrypted, nothing deleted) under owner '', which no
// authenticated key id can match, so they are unreachable through the API.
if (!hasColumn('vault_entries', 'owner')) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE vault_entries RENAME TO vault_entries_legacy;
      CREATE TABLE vault_entries (
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        enc TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, name)
      );
      INSERT INTO vault_entries (owner, name, enc, iv, tag, created_at, hits)
        SELECT '', name, enc, iv, tag, created_at, hits FROM vault_entries_legacy;
      DROP TABLE vault_entries_legacy;
    `)
  })()
  console.log('[db] migrated vault_entries -> per-owner (owner, name) key; legacy rows are unowned')
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_settlements_chain ON settlements(chain_id);`)

// Must run AFTER the settlements chain_id rebuild above (that copy lists columns explicitly).
if (!hasColumn('settlements', 'failed_splits')) db.exec('ALTER TABLE settlements ADD COLUMN failed_splits TEXT')
if (!hasColumn('settlements', 'refund_due')) db.exec('ALTER TABLE settlements ADD COLUMN refund_due TEXT')

module.exports = db
