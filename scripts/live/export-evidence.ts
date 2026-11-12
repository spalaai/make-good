/** Exports the ids, ledger lines and audit event names of a live demo database to a JSON file (no emails, no raw audit details).
 *  npx tsx scripts/live/export-evidence.ts data/demo-live.db docs/live/live-demo-run.json */
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const [dbPath, out] = process.argv.slice(2);
if (!dbPath || !out) { console.error("Usage: export-evidence.ts <db> <out.json>"); process.exit(2); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql: string) => db.prepare(sql).all();
const data = {
  note: "PayPal sandbox, play money. Exported from the database of a live console run. Emails and raw audit details are left out.",
  incidents: all("SELECT i.id, p.order_id, p.capture_id, p.amount_cents AS purchase_cents, i.status, i.remedy, i.amount_cents, i.dispute_id, i.dispute_status, i.refund_id, i.created_at, i.updated_at FROM incidents i JOIN purchases p ON p.id = i.purchase_id ORDER BY i.created_at"),
  payouts: all("SELECT incident_id, sender_batch_id, sender_item_id, amount_cents, status, paypal_batch_id, paypal_item_id, transaction_id, created_at, updated_at FROM payouts"),
  ledger: all("SELECT at, incident_id, account, amount_cents, kind, ref, label FROM ledger_entries ORDER BY at"),
  audit_events: all("SELECT at, actor, event, incident_id FROM audit_log ORDER BY at"),
};
writeFileSync(out, JSON.stringify(data, null, 1));
console.log(`wrote ${out}: ${data.incidents.length} incidents, ${data.payouts.length} payouts, ${data.ledger.length} ledger lines, ${data.audit_events.length} audit events`);
