import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB_PATH = "./data/make-good.db";

export function openDatabase(path = DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('agent', 'owner'))
    );

    -- One agent purchase and its receipt bundle (records_json is the list of numbered records).
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      fixture_key TEXT,
      order_id TEXT NOT NULL,
      capture_id TEXT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      buyer_email TEXT,
      merchant_name TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      records_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES purchases(id),
      complaint TEXT NOT NULL,
      claimed_cents INTEGER,
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      dispute_id TEXT,
      dispute_status TEXT,
      dispute_stage TEXT,
      dispute_allowed_json TEXT,
      dispute_synced_at TEXT,
      proposal_json TEXT,
      ai_source_json TEXT,
      decision_json TEXT,
      remedy TEXT,
      amount_cents INTEGER,
      approval_hash TEXT,
      approved_by TEXT,
      approved_at TEXT,
      refund_id TEXT,
      offer_made_at TEXT,
      evidence_note TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      judge_json TEXT,
      judge_source_json TEXT
    );

    -- sender_batch_id is written here BEFORE anything is sent to PayPal. One payout per incident.
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL UNIQUE REFERENCES incidents(id),
      sender_batch_id TEXT NOT NULL UNIQUE,
      sender_item_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      receiver_email TEXT NOT NULL,
      status TEXT NOT NULL,
      paypal_batch_id TEXT,
      paypal_item_id TEXT,
      transaction_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Who paid what. Append only. The operator account is a labelled ledger line, not a separate PayPal account.
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      account TEXT NOT NULL CHECK (account IN ('merchant', 'operator', 'buyer')),
      amount_cents INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT,
      label TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_settlement_per_incident
      ON ledger_entries (incident_id, account, kind);

    CREATE TRIGGER IF NOT EXISTS ledger_no_update
    BEFORE UPDATE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger_entries is append only');
    END;
    CREATE TRIGGER IF NOT EXISTS ledger_no_delete
    BEFORE DELETE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger_entries is append only');
    END;

    -- Webhook deliveries already handled, so a repeat of the same event id does nothing.
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      incident_id TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      incident_id TEXT,
      event TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append only');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append only');
    END;
  `);
  // Databases made before the judge existed get the two judge columns.
  const cols = (db.prepare("PRAGMA table_info(incidents)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["judge_json", "judge_source_json"]) if (!cols.includes(c)) db.exec(`ALTER TABLE incidents ADD COLUMN ${c} TEXT`);
}
