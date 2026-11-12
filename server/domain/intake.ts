import { z } from "zod";
import { appendAudit } from "./audit.js";
import { DomainError, type Actor, type Ctx } from "./ctx.js";
import { getIncident, getPurchase, newId, type Incident, type Purchase } from "./repo.js";

const recordSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(["instruction", "mandate", "listing", "cart", "tracking", "delivery"]),
  label: z.string().min(1).max(120),
  text: z.string().min(1).max(4000),
});

export const purchaseInputSchema = z.object({
  orderId: z.string().min(1).max(80),
  captureId: z.string().min(1).max(80).nullish(),
  amountCents: z.number().int().positive().max(10_000_000),
  currency: z.literal("USD").default("USD"),
  buyerEmail: z.string().email().max(200).nullish(),
  merchantName: z.string().min(1).max(120),
  operatorName: z.string().min(1).max(120),
  fixtureKey: z.string().max(60).nullish(),
  records: z.array(recordSchema).min(1).max(20),
});

export const incidentInputSchema = z.object({
  purchaseId: z.string().min(1),
  complaint: z.string().min(1).max(2000),
  claimedCents: z.number().int().positive().nullish(),
  disputeId: z.string().min(1).max(60).nullish(),
});

/** Store one agent purchase and its receipt bundle. */
export function recordPurchase(ctx: Ctx, raw: unknown, actor: Actor): Purchase {
  const parsed = purchaseInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(`Purchase is not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  const p = parsed.data;
  const ids = new Set(p.records.map((r) => r.id));
  if (ids.size !== p.records.length) throw new DomainError("Record ids must be unique.");
  const id = newId("pur");
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, fixture_key, order_id, capture_id, amount_cents, currency, buyer_email, merchant_name, operator_name, records_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, p.fixtureKey ?? null, p.orderId, p.captureId ?? null, p.amountCents, p.currency, p.buyerEmail ?? null, p.merchantName, p.operatorName, JSON.stringify(p.records), new Date().toISOString());
  appendAudit(ctx.db, { actor: actor.name, role: actor.role, incidentId: null, event: "purchase_recorded", details: { purchaseId: id, orderId: p.orderId, amountCents: p.amountCents } });
  return getPurchase(ctx.db, id)!;
}

/** Open an incident for a purchase that went wrong. The worker (or a caller) builds the proposal next. */
export function openIncident(ctx: Ctx, raw: unknown, actor: Actor): Incident {
  const parsed = incidentInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(`Complaint is not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  const p = parsed.data;
  const purchase = getPurchase(ctx.db, p.purchaseId);
  if (!purchase) throw new DomainError("No such purchase.", 404);
  if (p.claimedCents && p.claimedCents > purchase.amountCents) throw new DomainError("The claimed amount is more than the purchase.");
  const open = ctx.db
    .prepare("SELECT id FROM incidents WHERE purchase_id = ? AND status NOT IN ('done','closed','rejected')")
    .get(p.purchaseId) as { id: string } | undefined;
  if (open) throw new DomainError("This purchase already has an open incident.", 409);
  const id = newId("inc");
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO incidents (id, purchase_id, complaint, claimed_cents, status, version, dispute_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'new', 1, ?, ?, ?)`,
    )
    .run(id, p.purchaseId, p.complaint, p.claimedCents ?? null, p.disputeId ?? null, now, now);
  appendAudit(ctx.db, { actor: actor.name, role: actor.role, incidentId: id, event: "incident_opened", details: { purchaseId: p.purchaseId, disputeId: p.disputeId ?? null } });
  return getIncident(ctx.db, id)!;
}
