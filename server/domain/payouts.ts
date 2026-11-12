import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isIndeterminateNetworkError } from "../adapters/paypal/http.js";
import { appendAudit } from "./audit.js";
import type { Ctx } from "./ctx.js";
import { FRIENDLY, logTechnical, plainOr } from "./friendly.js";
import { settle } from "./ledger.js";
import { getIncident, getPurchase, setStatus } from "./repo.js";

export type PayoutRow = {
  id: string;
  incidentId: string;
  senderBatchId: string;
  senderItemId: string;
  requestId: string;
  amountCents: number;
  receiverEmail: string;
  status: "prepared" | "sent" | "success" | "failed" | "unknown";
  paypalBatchId: string | null;
  paypalItemId: string | null;
  transactionId: string | null;
  error: string | null;
};

function rowToPayout(r: Record<string, unknown>): PayoutRow {
  return {
    id: String(r.id),
    incidentId: String(r.incident_id),
    senderBatchId: String(r.sender_batch_id),
    senderItemId: String(r.sender_item_id),
    requestId: String(r.request_id),
    amountCents: Number(r.amount_cents),
    receiverEmail: String(r.receiver_email),
    status: String(r.status) as PayoutRow["status"],
    paypalBatchId: (r.paypal_batch_id as string | null) ?? null,
    paypalItemId: (r.paypal_item_id as string | null) ?? null,
    transactionId: (r.transaction_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

export function getPayoutForIncident(db: DatabaseSync, incidentId: string): PayoutRow | null {
  const r = db.prepare("SELECT * FROM payouts WHERE incident_id = ?").get(incidentId) as Record<string, unknown> | undefined;
  return r ? rowToPayout(r) : null;
}

export function listPayouts(db: DatabaseSync): PayoutRow[] {
  return (db.prepare("SELECT * FROM payouts ORDER BY created_at DESC, rowid DESC").all() as Array<Record<string, unknown>>).map(rowToPayout);
}

function update(db: DatabaseSync, id: string, patch: Partial<Pick<PayoutRow, "status" | "paypalBatchId" | "paypalItemId" | "transactionId" | "error">>): void {
  const cur = db.prepare("SELECT * FROM payouts WHERE id = ?").get(id) as Record<string, unknown>;
  const next = {
    status: patch.status ?? cur.status,
    paypal_batch_id: patch.paypalBatchId !== undefined ? patch.paypalBatchId : cur.paypal_batch_id,
    paypal_item_id: patch.paypalItemId !== undefined ? patch.paypalItemId : cur.paypal_item_id,
    transaction_id: patch.transactionId !== undefined ? patch.transactionId : cur.transaction_id,
    error: patch.error !== undefined ? patch.error : cur.error,
  };
  db.prepare("UPDATE payouts SET status = ?, paypal_batch_id = ?, paypal_item_id = ?, transaction_id = ?, error = ?, updated_at = ? WHERE id = ?").run(
    next.status as string,
    (next.paypal_batch_id as string | null) ?? null,
    (next.paypal_item_id as string | null) ?? null,
    (next.transaction_id as string | null) ?? null,
    (next.error as string | null) ?? null,
    new Date().toISOString(),
    id,
  );
}

/**
 * Step 1 of a payout. The ids are written to the database BEFORE anything is sent to PayPal.
 * Calling this again for the same incident returns the same row, so a retry can never invent a new sender_batch_id.
 */
export function preparePayout(ctx: Ctx, incidentId: string): PayoutRow {
  const existing = getPayoutForIncident(ctx.db, incidentId);
  if (existing) return existing;
  const incident = getIncident(ctx.db, incidentId);
  if (!incident || incident.amountCents == null) throw new Error("Incident has no decided amount.");
  const purchase = getPurchase(ctx.db, incident.purchaseId)!;
  if (!purchase.buyerEmail) throw new Error("The purchase has no buyer email to pay.");
  const token = randomUUID().replace(/-/g, "").slice(0, 16);
  const id = `pay_${token}`;
  ctx.db
    .prepare(
      `INSERT INTO payouts (id, incident_id, sender_batch_id, sender_item_id, request_id, amount_cents, receiver_email, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
    )
    .run(id, incidentId, `mg_batch_${token}`, `mg_item_${token}`, `mg-req-${token}`, incident.amountCents, purchase.buyerEmail, new Date().toISOString(), new Date().toISOString());
  appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_prepared", details: { payoutId: id, senderBatchId: `mg_batch_${token}`, amountCents: incident.amountCents } });
  return getPayoutForIncident(ctx.db, incidentId)!;
}

/**
 * Step 2: send what was saved in step 1, with the same ids every time.
 * If PayPal answers that the sender_batch_id already exists (the one sandbox run answered 400 USER_BUSINESS_ERROR), the payout
 * exists already, so the app looks it up and never sends again under a new id.
 */
export async function sendPayout(ctx: Ctx, incidentId: string): Promise<PayoutRow> {
  const p = getPayoutForIncident(ctx.db, incidentId);
  if (!p) throw new Error("Prepare the payout first.");
  if (p.status === "success" || p.status === "failed") return p;
  if (p.status === "sent" && p.paypalBatchId) return pollPayout(ctx, incidentId);

  let res;
  try {
    res = await ctx.payments.createPayout({
      senderBatchId: p.senderBatchId,
      senderItemId: p.senderItemId,
      requestId: p.requestId,
      receiverEmail: p.receiverEmail,
      amountCents: p.amountCents,
      note: `Make Good reimbursement for incident ${incidentId}`,
    });
  } catch (e) {
    logTechnical("payout", e);
    if (isIndeterminateNetworkError(e)) {
      update(ctx.db, p.id, { status: "unknown", error: FRIENDLY.paypalUnknown });
      appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_unknown", details: { senderBatchId: p.senderBatchId } });
      setStatus(ctx.db, incidentId, "unknown", FRIENDLY.paypalUnknown);
      return getPayoutForIncident(ctx.db, incidentId)!;
    }
    const msg = plainOr(String((e as Error).message), FRIENDLY.paypalFailed);
    update(ctx.db, p.id, { status: "failed", error: msg });
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_failed", details: { senderBatchId: p.senderBatchId, error: String((e as Error).message).slice(0, 300) } });
    setStatus(ctx.db, incidentId, "failed", msg);
    return getPayoutForIncident(ctx.db, incidentId)!;
  }

  if (res.outcome === "unknown") {
    update(ctx.db, p.id, { status: "unknown", error: FRIENDLY.paypalUnknown });
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_unknown", details: { senderBatchId: p.senderBatchId } });
    setStatus(ctx.db, incidentId, "unknown", FRIENDLY.paypalUnknown);
    return getPayoutForIncident(ctx.db, incidentId)!;
  }

  if (res.outcome === "duplicate") {
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_duplicate_lookup", details: { senderBatchId: p.senderBatchId, paypalBatchId: res.paypalBatchId } });
    if (!res.paypalBatchId) {
      // PayPal says it exists but did not say which batch. Keep the ids, do not send again, ask a person.
      update(ctx.db, p.id, { status: "unknown", error: "PayPal already has this payout, but its batch id was not returned. Check it in PayPal." });
      setStatus(ctx.db, incidentId, "unknown", "PayPal already has this payout. Check it in PayPal.");
      return getPayoutForIncident(ctx.db, incidentId)!;
    }
  }

  update(ctx.db, p.id, { status: "sent", paypalBatchId: res.paypalBatchId, error: null });
  appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_sent", details: { senderBatchId: p.senderBatchId, paypalBatchId: res.paypalBatchId } });
  setStatus(ctx.db, incidentId, "payout_sent");
  return pollPayout(ctx, incidentId);
}

/** Follow the payout ITEM. The batch status can still read PROCESSING after the item is SUCCESS. */
export async function pollPayout(ctx: Ctx, incidentId: string): Promise<PayoutRow> {
  const p = getPayoutForIncident(ctx.db, incidentId);
  if (!p || !p.paypalBatchId || p.status === "success" || p.status === "failed") return p!;
  const s = await ctx.payments.getPayoutBatch(p.paypalBatchId);
  if (s.item === "success") {
    update(ctx.db, p.id, { status: "success", paypalItemId: s.paypalItemId, transactionId: s.transactionId, error: null });
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_success", details: { paypalBatchId: p.paypalBatchId, paypalItemId: s.paypalItemId, transactionId: s.transactionId } });
    settle(ctx.db, incidentId, "operator_payout", p.amountCents, s.paypalItemId ?? p.paypalBatchId);
    setStatus(ctx.db, incidentId, "done");
  } else if (s.item === "failed") {
    update(ctx.db, p.id, { status: "failed", error: s.errorName ?? s.rawItemStatus });
    appendAudit(ctx.db, { actor: "make-good", role: "system", incidentId, event: "payout_failed", details: { paypalBatchId: p.paypalBatchId, status: s.rawItemStatus } });
    setStatus(ctx.db, incidentId, "failed", "PayPal did not complete the payout. Nothing was paid.");
  }
  return getPayoutForIncident(ctx.db, incidentId)!;
}
