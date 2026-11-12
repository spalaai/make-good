import { z } from "zod";
import { appendAudit } from "./audit.js";
import { DomainError, type Actor, type Ctx } from "./ctx.js";
import { messageWarnings } from "./injection.js";
import { getIncident, getPurchase, type Incident } from "./repo.js";
import type { BundleRecord } from "../types.js";

const LABELS: Record<BundleRecord["kind"], string> = {
  instruction: "What the buyer asked for",
  mandate: "What the agent was allowed to do",
  listing: "Shop listing when bought",
  cart: "What the agent bought",
  tracking: "Shop fulfilment log",
  delivery: "Delivery status",
};

export const evidenceInputSchema = z.object({
  kind: z.enum(["instruction", "mandate", "listing", "cart", "tracking", "delivery"]),
  /** Where it came from, for example "Carrier scan, 12 Oct". Shown next to the record. */
  source: z.string().min(1).max(100).optional(),
  text: z.string().min(1).max(2000),
});

/**
 * The owner attaches one more record to a case that needs evidence. The record is added to the purchase's bundle with the owner's name and time,
 * the full text goes into the append-only audit log, and nothing is decided until the check is run again.
 */
export function addEvidence(ctx: Ctx, incidentId: string, raw: unknown, actor: Actor): Incident {
  if (actor.role !== "owner") throw new DomainError("Only the owner can attach evidence.", 403);
  const incident = getIncident(ctx.db, incidentId);
  if (!incident) throw new DomainError("No such incident.", 404);
  if (incident.status !== "needs_evidence" && incident.status !== "needs_person") {
    throw new DomainError("Evidence can only be attached while the case is waiting for it.", 409);
  }
  const parsed = evidenceInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(`Evidence is not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  const purchase = getPurchase(ctx.db, incident.purchaseId)!;
  const n = purchase.records.reduce((m, r) => Math.max(m, Number(/^r(\d+)$/.exec(r.id)?.[1] ?? 0)), 0) + 1;
  const record: BundleRecord = {
    id: `r${n}`,
    kind: parsed.data.kind,
    label: parsed.data.source ? `${LABELS[parsed.data.kind]}, added: ${parsed.data.source}` : `${LABELS[parsed.data.kind]}, added by the owner`,
    text: parsed.data.text.trim(),
    addedBy: actor.name,
    addedAt: new Date().toISOString(),
  };
  if (purchase.records.length >= 20) throw new DomainError("A bundle holds at most 20 records.");
  ctx.db.prepare("UPDATE purchases SET records_json = ? WHERE id = ?").run(JSON.stringify([...purchase.records, record]), purchase.id);
  appendAudit(ctx.db, {
    actor: actor.name,
    role: actor.role,
    incidentId,
    event: "evidence_added",
    details: { recordId: record.id, kind: record.kind, label: record.label, text: record.text, warnings: messageWarnings(record.text) },
  });
  ctx.db.prepare("UPDATE incidents SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), incidentId);
  return getIncident(ctx.db, incidentId)!;
}
