import { isIndeterminateNetworkError } from "../adapters/paypal/http.js";
import { appendAudit } from "./audit.js";
import { approvalHashFor, bindingFor } from "./approvalFor.js";
import { approvalTokenMatches } from "./approval.js";
import { DomainError, type Actor, type Ctx } from "./ctx.js";
import { canMakeRefundOffer, disputeIsOpen, saveDisputeSnapshot, syncIncidentDispute } from "./disputes.js";
import { FRIENDLY, logTechnical, plainOr } from "./friendly.js";
import { settle } from "./ledger.js";
import { claim, getIncident, getPurchase, setStatus, type Incident } from "./repo.js";
import { preparePayout, sendPayout } from "./payouts.js";
import { verifyQuotes } from "./rules.js";

/** The owner approves one exact action. If anything changed since the proposal, the token no longer matches. */
export async function approveIncident(ctx: Ctx, incidentId: string, presentedToken: string | undefined, actor: Actor): Promise<Incident> {
  if (actor.role !== "owner") throw new DomainError("Only the owner can approve.", 403);
  const incident = getIncident(ctx.db, incidentId);
  if (!incident) throw new DomainError("No such incident.", 404);
  if (incident.status !== "needs_owner" || !incident.remedy || incident.remedy === "abstain") {
    throw new DomainError("This incident is not waiting for approval.", 409);
  }
  if (!approvalTokenMatches(presentedToken, incident.approvalHash, bindingFor(incident))) {
    appendAudit(ctx.db, { actor: actor.name, role: actor.role, incidentId, event: "approval_blocked", details: { reason: "token does not match the current proposal" } });
    throw new DomainError("The proposal changed or the approval token is wrong. Open the incident again and review it.", 409);
  }
  const won = ctx.db
    .prepare("UPDATE incidents SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'needs_owner' AND version = ?")
    .run(actor.name, new Date().toISOString(), new Date().toISOString(), incidentId, incident.version);
  if (Number(won.changes) !== 1) throw new DomainError("Someone else just decided this incident.", 409);
  appendAudit(ctx.db, { actor: actor.name, role: actor.role, incidentId, event: "approved", details: { remedy: incident.remedy, amountCents: incident.amountCents, disputeId: incident.disputeId } });
  return executeIncident(ctx, incidentId);
}

export function rejectIncident(ctx: Ctx, incidentId: string, actor: Actor): Incident {
  if (actor.role !== "owner") throw new DomainError("Only the owner can reject.", 403);
  if (!claim(ctx.db, incidentId, ["needs_owner", "needs_person", "needs_evidence"], "rejected")) throw new DomainError("This incident cannot be rejected now.", 409);
  appendAudit(ctx.db, { actor: actor.name, role: actor.role, incidentId, event: "rejected", details: {} });
  return getIncident(ctx.db, incidentId)!;
}

/** Run an approved remedy. Safe to call again for waiting_paypal and unknown incidents. */
export async function executeIncident(ctx: Ctx, incidentId: string): Promise<Incident> {
  if (!claim(ctx.db, incidentId, ["approved", "waiting_paypal", "unknown"], "executing")) return getIncident(ctx.db, incidentId)!;
  const incident = getIncident(ctx.db, incidentId)!;
  // The approval must still match the action about to run.
  if (incident.approvalHash !== approvalHashFor(incident)) {
    setStatus(ctx.db, incidentId, "failed", "The approved action no longer matches. Nothing was changed.");
    return getIncident(ctx.db, incidentId)!;
  }
  try {
    if (incident.remedy === "merchant_refund") await runMerchantRefund(ctx, incident);
    else if (incident.remedy === "operator_payout") await runOperatorPayout(ctx, incident);
    else if (incident.remedy === "defend") await runDefend(ctx, incident);
    else setStatus(ctx.db, incidentId, "failed", "No remedy to run.");
  } catch (e) {
    logTechnical("execute", e);
    const unsure = isIndeterminateNetworkError(e);
    setStatus(ctx.db, incidentId, unsure ? "unknown" : "failed", plainOr(String((e as Error).message), unsure ? FRIENDLY.paypalUnknown : FRIENDLY.paypalFailed));
  }
  return getIncident(ctx.db, incidentId)!;
}

async function runMerchantRefund(ctx: Ctx, incident: Incident): Promise<void> {
  const amount = incident.amountCents!;
  if (incident.disputeId) {
    const d = await ctx.payments.getDispute(incident.disputeId);
    saveDisputeSnapshot(ctx, incident.id, d);
    if (!disputeIsOpen(d.status)) {
      setStatus(ctx.db, incident.id, "closed", "The dispute is already closed in PayPal.");
      return;
    }
    if (!canMakeRefundOffer(d)) {
      // PayPal lets the seller act only at certain moments (the one sandbox run waited about 4 minutes after filing).
      appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "offer_blocked", details: { status: d.status, allowed: d.allowedActions, offerTypes: d.offerTypes } });
      setStatus(ctx.db, incident.id, "waiting_paypal", "Waiting for PayPal to let the shop make an offer.");
      return;
    }
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "offer_requested", details: { disputeId: incident.disputeId, amountCents: amount } });
    const r = await ctx.payments.makeOffer({
      disputeId: incident.disputeId,
      amountCents: amount,
      note: `Refund offer of $${(amount / 100).toFixed(2)} for an order that did not arrive as listed.`,
      idempotencyKey: `mg-offer-${incident.id}`,
    });
    if (r.outcome === "unknown") {
      appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "offer_unknown", details: { disputeId: incident.disputeId } });
      setStatus(ctx.db, incident.id, "unknown", FRIENDLY.paypalUnknown);
      return;
    }
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "offer_made", details: { disputeId: incident.disputeId, amountCents: amount } });
    ctx.db.prepare("UPDATE incidents SET offer_made_at = ? WHERE id = ?").run(new Date().toISOString(), incident.id);
    // The buyer must accept inside PayPal. The dispute sync picks up the result.
    setStatus(ctx.db, incident.id, "offer_made");
    return;
  }

  // No dispute: a direct refund of the capture, with a request id so a repeat cannot pay twice.
  const purchase = getPurchase(ctx.db, incident.purchaseId)!;
  if (!purchase.captureId) {
    setStatus(ctx.db, incident.id, "failed", "There is no PayPal capture to refund.");
    return;
  }
  appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "refund_requested", details: { captureId: purchase.captureId, amountCents: amount } });
  const r = await ctx.payments.executeRefund({ incidentId: incident.id, amountCents: amount, captureId: purchase.captureId, idempotencyKey: `mg-refund-${incident.id}` });
  if (r.outcome === "confirmed") {
    ctx.db.prepare("UPDATE incidents SET refund_id = ? WHERE id = ?").run(r.refundId, incident.id);
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "refund_confirmed", details: { refundId: r.refundId } });
    settle(ctx.db, incident.id, "merchant_refund", amount, r.refundId);
    setStatus(ctx.db, incident.id, "done");
  } else if (r.outcome === "failed") {
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "refund_failed", details: { status: r.status } });
    setStatus(ctx.db, incident.id, "failed", FRIENDLY.refundFailed);
  } else {
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "refund_unknown", details: { status: r.status } });
    setStatus(ctx.db, incident.id, "unknown", FRIENDLY.refundNotDone);
  }
}

async function runOperatorPayout(ctx: Ctx, incident: Incident): Promise<void> {
  // No payout while a dispute on this purchase is open, or the buyer could be paid twice.
  if (incident.disputeId) {
    const synced = await syncIncidentDispute(ctx, incident);
    if (disputeIsOpen(synced.disputeStatus)) {
      setStatus(ctx.db, incident.id, "failed", "The buyer has an open dispute on this purchase. Settle it in PayPal first.");
      return;
    }
  }
  preparePayout(ctx, incident.id);
  await sendPayout(ctx, incident.id);
}

export function buildEvidenceNote(incident: Incident, records: ReturnType<typeof getPurchase> & {}): string {
  const proposal = incident.proposal;
  if (!proposal) return "";
  const ok = verifyQuotes(proposal, records.records).filter((v) => v.ok);
  const lines = ok.map((v) => {
    const rec = records.records.find((r) => r.id === v.recordId)!;
    return `- ${rec.label}: "${v.quote}"`;
  });
  return `The shop delivered this order. Records from the shop:\n${lines.join("\n")}`;
}

async function runDefend(ctx: Ctx, incident: Incident): Promise<void> {
  const purchase = getPurchase(ctx.db, incident.purchaseId)!;
  const note = buildEvidenceNote(incident, purchase);
  ctx.db.prepare("UPDATE incidents SET evidence_note = ? WHERE id = ?").run(note, incident.id);
  appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "evidence_prepared", details: { lines: note.split("\n").length - 1 } });
  if (!incident.disputeId) {
    setStatus(ctx.db, incident.id, "evidence_ready");
    return;
  }
  // Only what PayPal says is open right now. Nothing is sent without the owner's approval of this exact text (the approval token binds the dispute, not the text,
  // so the text is built only from verified quotes and shown to the owner on the incident page before approval).
  const d = await ctx.payments.getDispute(incident.disputeId);
  saveDisputeSnapshot(ctx, incident.id, d);
  if (!disputeIsOpen(d.status)) {
    setStatus(ctx.db, incident.id, "closed", "The dispute is already closed in PayPal.");
    return;
  }
  const key = `mg-evidence-${incident.id}`;
  let r;
  if (d.allowedActions.includes("provide_evidence")) r = await ctx.payments.provideEvidence({ disputeId: incident.disputeId, notes: note, idempotencyKey: key });
  else if (d.allowedActions.includes("send_message")) r = await ctx.payments.sendMessage({ disputeId: incident.disputeId, message: note, idempotencyKey: key });
  else {
    setStatus(ctx.db, incident.id, "evidence_ready", "The evidence is ready. PayPal does not let the shop send it right now.");
    return;
  }
  if (r.outcome === "unknown") {
    setStatus(ctx.db, incident.id, "unknown", FRIENDLY.paypalUnknown);
    return;
  }
  appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId: incident.id, event: "evidence_sent", details: { disputeId: incident.disputeId, via: d.allowedActions.includes("provide_evidence") ? "provide_evidence" : "send_message" } });
  settle(ctx.db, incident.id, "defended", 0, incident.disputeId);
  setStatus(ctx.db, incident.id, "done");
}
