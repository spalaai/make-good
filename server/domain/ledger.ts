import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.js";

export const OPERATOR_LABEL = "Operator ledger line. In the sandbox it is paid from the same PayPal balance as the shop.";

export type LedgerEntry = {
  id: string;
  at: string;
  incidentId: string;
  account: "merchant" | "operator" | "buyer";
  amountCents: number;
  kind: string;
  ref: string | null;
  label: string;
};

function put(db: DatabaseSync, incidentId: string, account: LedgerEntry["account"], amountCents: number, kind: string, ref: string | null, label: string): boolean {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO ledger_entries (id, at, incident_id, account, amount_cents, kind, ref, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), new Date().toISOString(), incidentId, account, amountCents, kind, ref, label);
  return Number(r.changes) === 1;
}

/** Negative is money the account paid out. Positive is money it received. Written once per settlement, repeats are ignored. */
export function settle(
  db: DatabaseSync,
  incidentId: string,
  kind: "merchant_refund" | "operator_payout" | "defended",
  amountCents: number,
  ref: string | null,
): void {
  db.exec("BEGIN");
  try {
    let wrote = false;
    if (kind === "merchant_refund") {
      wrote = put(db, incidentId, "merchant", -amountCents, kind, ref, "Shop refunded the buyer through PayPal.");
      put(db, incidentId, "buyer", amountCents, kind, ref, "Buyer received the refund.");
    } else if (kind === "operator_payout") {
      wrote = put(db, incidentId, "operator", -amountCents, kind, ref, OPERATOR_LABEL);
      put(db, incidentId, "buyer", amountCents, kind, ref, "Buyer received the reimbursement.");
      put(db, incidentId, "merchant", 0, "sale_retained", ref, "Shop delivered what it listed and keeps the sale.");
    } else {
      wrote = put(db, incidentId, "merchant", 0, "defended", ref, "Claim defended with the shop's records. No money moved.");
    }
    if (wrote) appendAudit(db, { actor: "make-good", role: "system", incidentId, event: "ledger_written", details: { kind, amountCents, ref } });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listLedger(db: DatabaseSync): LedgerEntry[] {
  return (
    db.prepare("SELECT id, at, incident_id, account, amount_cents, kind, ref, label FROM ledger_entries ORDER BY at DESC, rowid DESC").all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    at: String(r.at),
    incidentId: String(r.incident_id),
    account: r.account as LedgerEntry["account"],
    amountCents: Number(r.amount_cents),
    kind: String(r.kind),
    ref: (r.ref as string | null) ?? null,
    label: String(r.label),
  }));
}

export function totalsByAccount(db: DatabaseSync): Record<"merchant" | "operator" | "buyer", number> {
  const out = { merchant: 0, operator: 0, buyer: 0 };
  for (const r of db.prepare("SELECT account, SUM(amount_cents) AS total FROM ledger_entries GROUP BY account").all() as Array<{ account: keyof typeof out; total: number }>) {
    out[r.account] = Number(r.total);
  }
  return out;
}
