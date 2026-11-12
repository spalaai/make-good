import { appendAudit } from "./audit.js";
import { approvalHashFor } from "./approvalFor.js";
import { DomainError, type Actor, type Ctx } from "./ctx.js";
import { decide } from "./rules.js";
import { disputeIsOpen, syncIncidentDispute } from "./disputes.js";
import { FRIENDLY, logTechnical } from "./friendly.js";
import { aiProposalSchema } from "./aiSchema.js";
import { checkJudge, type JudgeChecked } from "./judge.js";
import type { AiSource } from "../adapters/ai.js";
import { claim, getIncident, getPurchase, setStatus, type Incident } from "./repo.js";

/**
 * AI proposes, an independent judge weighs the evidence, a fixed rule decides. The AI answer is validated, every quote is checked
 * against the records, a second AI pass (its own prompt, its own model where one is configured) says whether each quote really supports
 * the conclusion and whether the AI left out a record that points the other way, and then the rule picks the remedy and the amount.
 * Anything the rule cannot back becomes "needs evidence" (a list of records to attach) or "ask a person". If the judge cannot be reached, nothing is decided.
 * The owner can attach records to an incident that needs evidence and run this again.
 */
export async function proposeIncident(ctx: Ctx, incidentId: string, actor: Actor): Promise<Incident> {
  const first = getIncident(ctx.db, incidentId);
  if (!first) throw new DomainError("No such incident.", 404);
  if (["needs_evidence", "needs_person"].includes(first.status) && actor.role === "agent") throw new DomainError("Only the owner can ask for another check.", 403);
  if (!claim(ctx.db, incidentId, ["new", "failed", "needs_evidence", "needs_person"], "analyzing")) {
    throw new DomainError("This incident is not waiting for a proposal.", 409);
  }
  appendAudit(ctx.db, { actor: actor.name, role: actor.role, incidentId, event: "agent_picked_up", details: {} });

  let incident = getIncident(ctx.db, incidentId)!;
  const purchase = getPurchase(ctx.db, incident.purchaseId)!;
  if (incident.disputeId) incident = await syncIncidentDispute(ctx, incident);

  let result;
  try {
    result = await ctx.ai.proposeFault({
      purchaseId: purchase.id,
      fixtureKey: purchase.fixtureKey,
      amountCents: purchase.amountCents,
      merchantName: purchase.merchantName,
      operatorName: purchase.operatorName,
      records: purchase.records,
      complaint: incident.complaint,
    });
  } catch (e) {
    logTechnical("proposal", e);
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "proposal_failed", details: { error: String((e as Error).message).slice(0, 300) } });
    setStatus(ctx.db, incidentId, "failed", FRIENDLY.aiFailed);
    return getIncident(ctx.db, incidentId)!;
  }

  const parsed = aiProposalSchema.safeParse(result.proposal);
  if (!parsed.success) {
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "proposal_failed", details: { error: "AI answer failed the schema" } });
    setStatus(ctx.db, incidentId, "failed", FRIENDLY.aiFailed);
    return getIncident(ctx.db, incidentId)!;
  }
  const proposal = parsed.data;
  appendAudit(ctx.db, { actor: "ai", role: "system", incidentId, event: "proposal_built", details: { fault: proposal.fault, confidence: proposal.confidence, source: result.source, citations: proposal.citations.length } });

  // The independent judge. If it cannot answer, the rule gets null and stops: nothing is decided without it.
  let judge: JudgeChecked | null = null;
  let judgeSource: AiSource | null = null;
  try {
    const jr = await ctx.ai.judgeEvidence({
      purchaseId: purchase.id,
      fixtureKey: purchase.fixtureKey,
      amountCents: purchase.amountCents,
      merchantName: purchase.merchantName,
      operatorName: purchase.operatorName,
      records: purchase.records,
      complaint: incident.complaint,
      proposal,
    });
    judge = checkJudge(proposal, purchase.records, jr.verdict);
    judgeSource = jr.source;
    appendAudit(ctx.db, {
      actor: "judge",
      role: "system",
      incidentId,
      event: "judge_verdict",
      details: {
        overall: judge.overall,
        quotes: judge.quoteChecks.map((q) => q.role),
        contradictions: judge.contradictions.map((c) => ({ recordId: c.recordId, verified: c.verified, addressed: c.addressed })),
        missing: judge.missing.length,
        source: jr.source,
      },
    });
  } catch (e) {
    logTechnical("judge", e);
    appendAudit(ctx.db, { actor: "judge", role: "system", incidentId, event: "judge_failed", details: { error: String((e as Error).message).slice(0, 300) } });
  }

  // Another incident on the same purchase with an open dispute is not possible (one open incident per purchase),
  // so "open dispute on the purchase" means this incident's own dispute.
  const decision = decide({
    proposal,
    records: purchase.records,
    purchaseAmountCents: purchase.amountCents,
    claimedCents: incident.claimedCents,
    complaint: incident.complaint,
    policy: ctx.policy,
    openDisputeOnPurchase: !!incident.disputeId && disputeIsOpen(incident.disputeStatus),
    judge,
  });
  appendAudit(ctx.db, { actor: "rule", role: "system", incidentId, event: "decision_made", details: { remedy: decision.remedy, amountCents: decision.amountCents, abstainReason: decision.abstainReason, stop: decision.stop ?? null, evidenceRequests: decision.evidenceRequests?.length ?? 0 } });

  const newVersion = incident.version + 1;
  const status = decision.remedy === "abstain" ? (decision.stop === "need_evidence" ? "needs_evidence" : "needs_person") : "needs_owner";
  const hash = decision.remedy === "abstain" ? null : approvalHashFor({ ...incident, version: newVersion, remedy: decision.remedy, amountCents: decision.amountCents });
  ctx.db
    .prepare(
      `UPDATE incidents SET status = ?, version = ?, proposal_json = ?, ai_source_json = ?, judge_json = ?, judge_source_json = ?, decision_json = ?, remedy = ?, amount_cents = ?, approval_hash = ?, error = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(status, newVersion, JSON.stringify(proposal), JSON.stringify(result.source), judge ? JSON.stringify(judge) : null, judgeSource ? JSON.stringify(judgeSource) : null, JSON.stringify(decision), decision.remedy, decision.amountCents, hash, new Date().toISOString(), incidentId);
  return getIncident(ctx.db, incidentId)!;
}
