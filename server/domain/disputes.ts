import type { DisputeSummary } from "../adapters/payments.js";
import { appendAudit } from "./audit.js";
import type { Ctx } from "./ctx.js";
import { logTechnical } from "./friendly.js";
import { settle } from "./ledger.js";
import { getIncident, getPurchase, listIncidents, setStatus, type Incident } from "./repo.js";

const CLOSED_STATUSES = new Set(["RESOLVED", "CANCELLED", "CLOSED"]);

export function disputeIsOpen(status: string | null): boolean {
  return !!status && !CLOSED_STATUSES.has(status);
}

/** True when the offer is already out and the buyer has to answer. */
const WAITING_FOR_BUYER = "WAITING_FOR_BUYER_RESPONSE";

export function canMakeRefundOffer(d: DisputeSummary): boolean {
  return d.allowedActions.includes("make_offer") && d.offerTypes.includes("REFUND");
}

export function saveDisputeSnapshot(ctx: Ctx, incidentId: string, d: DisputeSummary): void {
  ctx.db
    .prepare("UPDATE incidents SET dispute_status = ?, dispute_stage = ?, dispute_allowed_json = ?, dispute_synced_at = ?, updated_at = ? WHERE id = ?")
    .run(d.status, d.stage, JSON.stringify(d.allowedActions), new Date().toISOString(), new Date().toISOString(), incidentId);
}

/**
 * Read the dispute from PayPal, save what it says, and move the incident if PayPal moved first.
 * The buyer accepts an offer inside PayPal. This is where the app finds out.
 */
export async function syncIncidentDispute(ctx: Ctx, incident: Incident): Promise<Incident> {
  if (!incident.disputeId) return incident;
  let d: DisputeSummary;
  try {
    d = await ctx.payments.getDispute(incident.disputeId);
  } catch (e) {
    logTechnical("dispute sync", e);
    return incident;
  }
  saveDisputeSnapshot(ctx, incident.id, d);
  appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "dispute_synced", details: { disputeId: d.disputeId, status: d.status, allowed: d.allowedActions } });

  if (incident.remedy === "merchant_refund" && (incident.status === "offer_made" || incident.status === "unknown")) {
    if (d.status === "RESOLVED" && d.outcome === "RESOLVED_BUYER_FAVOUR") {
      const paid = d.refundedCents ?? incident.amountCents ?? 0;
      // PayPal issued the refund itself when it settled the dispute. Read its id so the ledger and the page can show it.
      let refundId: string | null = null;
      try {
        const purchase = getPurchase(ctx.db, incident.purchaseId);
        const found = purchase ? await ctx.payments.findRefund({ orderId: purchase.orderId, amountCents: paid }) : null;
        if (found) {
          refundId = found.refundId;
          ctx.db.prepare("UPDATE incidents SET refund_id = ? WHERE id = ?").run(refundId, incident.id);
          appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "refund_confirmed", details: { refundId, source: "read from the order after the dispute resolved" } });
        }
      } catch (e) {
        logTechnical("refund lookup", e);
      }
      settle(ctx.db, incident.id, "merchant_refund", paid, refundId ?? d.disputeId);
      appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "dispute_resolved", details: { outcome: d.outcome, refundedCents: paid } });
      setStatus(ctx.db, incident.id, "done");
    } else if (CLOSED_STATUSES.has(d.status)) {
      appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "dispute_resolved", details: { outcome: d.outcome, note: "closed without a refund to the buyer" } });
      setStatus(ctx.db, incident.id, "closed", "The dispute closed in PayPal without a refund to the buyer.");
    } else if (incident.status === "unknown" && d.status === WAITING_FOR_BUYER) {
      // The offer did go through even though no answer came back. Now the buyer has to accept in PayPal.
      setStatus(ctx.db, incident.id, "offer_made");
    }
  }
  return getIncident(ctx.db, incident.id)!;
}

/** Sync every incident that has a dispute and is not finished. */
export async function syncAllDisputes(ctx: Ctx): Promise<number> {
  let n = 0;
  for (const inc of listIncidents(ctx.db)) {
    if (!inc.disputeId) continue;
    if (["done", "closed", "rejected"].includes(inc.status)) continue;
    await syncIncidentDispute(ctx, inc);
    n += 1;
  }
  return n;
}
