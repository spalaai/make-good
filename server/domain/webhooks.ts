import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.js";
import type { Ctx, WebhookHeaders } from "./ctx.js";
import { syncIncidentDispute } from "./disputes.js";
import { getIncident } from "./repo.js";

export type WebhookOutcome = { status: number; body: { ok: boolean; note: string } };

function incidentForDispute(db: DatabaseSync, disputeId: string): string | null {
  const r = db.prepare("SELECT id FROM incidents WHERE dispute_id = ? ORDER BY created_at DESC LIMIT 1").get(disputeId) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * A PayPal dispute event arrived. The app only acts if PayPal's own verification says it is genuine. Acting means one thing:
 * read the dispute from PayPal again (the event body is never trusted for status or amounts) and let the normal sync move the incident.
 */
export async function handleWebhook(ctx: Ctx, headers: WebhookHeaders, event: unknown): Promise<WebhookOutcome> {
  const ok = ctx.webhookVerifier ? await ctx.webhookVerifier(headers, event).catch(() => false) : false;
  if (!ok) {
    appendAudit(ctx.db, { actor: "paypal-webhook", role: "system", incidentId: null, event: "webhook_rejected", details: { reason: "not verified" } });
    return { status: 401, body: { ok: false, note: "Not verified." } };
  }
  const e = (event ?? {}) as { id?: string; event_type?: string; resource?: { dispute_id?: string } };
  if (!e.id || !e.event_type) return { status: 400, body: { ok: false, note: "No event id or type." } };
  if (!e.event_type.startsWith("CUSTOMER.DISPUTE.")) return { status: 200, body: { ok: true, note: "Ignored event type." } };
  const disputeId = e.resource?.dispute_id;
  const incidentId = disputeId ? incidentForDispute(ctx.db, disputeId) : null;
  const first = ctx.db.prepare("INSERT OR IGNORE INTO webhook_events (id, at, event_type, incident_id) VALUES (?, ?, ?, ?)").run(e.id, new Date().toISOString(), e.event_type, incidentId);
  if (Number(first.changes) !== 1) return { status: 200, body: { ok: true, note: "Already handled." } };
  appendAudit(ctx.db, { actor: "paypal-webhook", role: "system", incidentId, event: "webhook_received", details: { eventId: e.id, type: e.event_type, disputeId: disputeId ?? null } });
  if (!incidentId) return { status: 200, body: { ok: true, note: "No incident for that dispute." } };
  await syncIncidentDispute(ctx, getIncident(ctx.db, incidentId)!);
  return { status: 200, body: { ok: true, note: "Synced." } };
}
