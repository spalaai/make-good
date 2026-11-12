import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AuditEvent =
  | "purchase_recorded"
  | "incident_opened"
  | "proposal_built"
  | "proposal_failed"
  | "decision_made"
  | "judge_verdict"
  | "judge_failed"
  | "evidence_added"
  | "approved"
  | "approval_blocked"
  | "rejected"
  | "refund_requested"
  | "refund_confirmed"
  | "refund_unknown"
  | "refund_failed"
  | "offer_blocked"
  | "offer_requested"
  | "offer_made"
  | "offer_unknown"
  | "dispute_synced"
  | "dispute_resolved"
  | "payout_prepared"
  | "payout_sent"
  | "payout_duplicate_lookup"
  | "payout_success"
  | "payout_failed"
  | "payout_unknown"
  | "evidence_prepared"
  | "evidence_sent"
  | "ledger_written"
  | "agent_picked_up"
  | "webhook_received"
  | "webhook_rejected"
  | "demo_reset";

export function appendAudit(
  db: DatabaseSync,
  entry: {
    actor: string;
    role: string;
    incidentId: string | null;
    event: AuditEvent;
    details: Record<string, unknown>;
  },
): string {
  const id = randomUUID();
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_log (id, at, actor, role, incident_id, event, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    at,
    entry.actor,
    entry.role,
    entry.incidentId,
    entry.event,
    JSON.stringify(entry.details),
  );
  return id;
}

export function listAudit(db: DatabaseSync, limit = 200) {
  return db
    .prepare(
      `SELECT id, at, actor, role, incident_id as incidentId, event, details_json as detailsJson
       FROM audit_log ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    at: string;
    actor: string;
    role: string;
    incidentId: string | null;
    event: string;
    detailsJson: string;
  }>;
}
