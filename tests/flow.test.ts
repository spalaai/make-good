import { describe, expect, it } from "vitest";
import { listAudit } from "../server/domain/audit.js";
import { syncIncidentDispute } from "../server/domain/disputes.js";
import { approveIncident, executeIncident, rejectIncident } from "../server/domain/execute.js";
import { listLedger, totalsByAccount } from "../server/domain/ledger.js";
import { getPayoutForIncident } from "../server/domain/payouts.js";
import { openIncident } from "../server/domain/intake.js";
import { proposeIncident } from "../server/domain/propose.js";
import { getIncident } from "../server/domain/repo.js";
import { workerTick } from "../server/domain/worker.js";
import { AGENT, OWNER, makeCtx, seedFixture } from "./helpers.js";

const SYSTEM = { name: "make-good", role: "system" as const };

async function proposed(ctx: ReturnType<typeof makeCtx>, key: string, opts: Parameters<typeof seedFixture>[2] = {}) {
  const { incident } = seedFixture(ctx, key, opts);
  return proposeIncident(ctx, incident.id, SYSTEM);
}

describe("propose then approve", () => {
  it("builds a proposal, applies the rule, and waits for the owner", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "never-delivered");
    expect(i.status).toBe("needs_owner");
    expect(i.remedy).toBe("merchant_refund");
    expect(i.amountCents).toBe(2000);
    expect(i.approvalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(i.aiSource?.kind).toBe("recorded");
  });

  it("an ambiguous incident asks for specific records, has no approval token, and cannot be approved", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "ambiguous");
    expect(i.status).toBe("needs_evidence");
    expect(i.decision?.evidenceRequests?.length).toBeGreaterThan(0);
    expect(i.approvalHash).toBeNull();
    await expect(approveIncident(ctx, i.id, "anything", OWNER)).rejects.toThrow(/not waiting for approval/);
    expect(ctx.payments.offers).toHaveLength(0);
    expect(listLedger(ctx.db)).toHaveLength(0);
  });

  it("refuses a wrong token, logs it, and changes nothing", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    await expect(approveIncident(ctx, i.id, "0".repeat(64), OWNER)).rejects.toThrow(/token/);
    expect(getIncident(ctx.db, i.id)!.status).toBe("needs_owner");
    expect(listAudit(ctx.db).some((a) => a.event === "approval_blocked")).toBe(true);
    expect(ctx.payments.payoutsBySenderBatch.size).toBe(0);
  });

  it("refuses a token once the amount was changed after the proposal", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    ctx.db.prepare("UPDATE incidents SET amount_cents = 2500 WHERE id = ?").run(i.id);
    await expect(approveIncident(ctx, i.id, i.approvalHash!, OWNER)).rejects.toThrow(/token/);
    expect(ctx.payments.payoutsBySenderBatch.size).toBe(0);
  });

  it("only the owner can approve or reject", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    await expect(approveIncident(ctx, i.id, i.approvalHash!, AGENT)).rejects.toThrow(/owner/);
    expect(() => rejectIncident(ctx, i.id, AGENT)).toThrow(/owner/);
  });

  it("rejecting closes it with no money", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    expect(rejectIncident(ctx, i.id, OWNER).status).toBe("rejected");
    expect(listLedger(ctx.db)).toHaveLength(0);
  });

  it("a second approval of the same proposal is refused", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    await expect(approveIncident(ctx, i.id, i.approvalHash!, OWNER)).rejects.toThrow();
    expect(ctx.payments.payoutsBySenderBatch.size).toBe(1);
  });

  it("one open incident per purchase", () => {
    const ctx = makeCtx();
    const { purchase } = seedFixture(ctx, "wrong-edition");
    expect(() => openIncident(ctx, { purchaseId: purchase.id, complaint: "again" }, AGENT)).toThrow(/already has an open incident/);
  });

  it("the AI failing leaves the incident failed and untouched by money", async () => {
    const ctx = makeCtx({
      ai: { kind: "live", provider: "x", model: "y", modeLabel: "x", fallbackToRecorded: false, proposeFault: async () => { throw new Error("AI API error (503): busy"); }, judgeEvidence: async () => { throw new Error("no judge"); } },
    });
    const i = await proposed(ctx, "never-delivered");
    expect(i.status).toBe("failed");
    expect(i.error).not.toMatch(/503|API/);
  });
});

describe("shop at fault: a refund offer, then the buyer accepts in PayPal", () => {
  it("makes the offer, waits for the buyer, and writes the ledger only after PayPal resolves it", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "never-delivered", { disputeId: "MG-DISPUTE-1" });
    const after = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(after.status).toBe("offer_made");
    expect(ctx.payments.offers).toEqual([expect.objectContaining({ disputeId: "MG-DISPUTE-1", amountCents: 2000 })]);
    expect(listLedger(ctx.db)).toHaveLength(0); // nothing is settled until the buyer accepts

    // Nothing changes while the buyer has not accepted.
    expect((await syncIncidentDispute(ctx, getIncident(ctx.db, i.id)!)).status).toBe("offer_made");

    ctx.payments.buyerAccepts("MG-DISPUTE-1");
    const done = await syncIncidentDispute(ctx, getIncident(ctx.db, i.id)!);
    expect(done.status).toBe("done");
    const totals = totalsByAccount(ctx.db);
    expect(totals).toEqual({ merchant: -2000, operator: 0, buyer: 2000 });
    // The refund PayPal issued is looked up on the order and shown with the incident and on the ledger lines.
    expect(done.refundId).toMatch(/^MOCK-REFUND-/);
    expect(listLedger(ctx.db).every((l) => l.ref === done.refundId)).toBe(true);
  });

  it("waits when PayPal has not opened the seller turn yet, then makes the offer on a later pass", async () => {
    const ctx = makeCtx();
    ctx.payments.registerDispute({ disputeId: "D-LATE", amountCents: 2000, status: "UNDER_REVIEW", allowedActions: [] });
    const i = await proposed(ctx, "never-delivered", { disputeId: "D-LATE" });
    const waiting = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(waiting.status).toBe("waiting_paypal");
    expect(ctx.payments.offers).toHaveLength(0);

    await workerTick(ctx);
    expect(getIncident(ctx.db, i.id)!.status).toBe("waiting_paypal");

    ctx.payments.patchDispute("D-LATE", { status: "WAITING_FOR_SELLER_RESPONSE", allowedActions: ["make_offer"] });
    await workerTick(ctx);
    expect(getIncident(ctx.db, i.id)!.status).toBe("offer_made");
    expect(ctx.payments.offers).toHaveLength(1);
  });

  it("does not offer when PayPal does not list REFUND as an offer type", async () => {
    const ctx = makeCtx();
    ctx.payments.registerDispute({ disputeId: "D-X", amountCents: 2000 });
    ctx.payments.patchDispute("D-X", { offerTypes: ["REFUND_WITH_RETURN"] });
    const i = await proposed(ctx, "never-delivered", { disputeId: "D-X" });
    expect((await approveIncident(ctx, i.id, i.approvalHash!, OWNER)).status).toBe("waiting_paypal");
    expect(ctx.payments.offers).toHaveLength(0);
  });

  it("closes without a ledger entry when the dispute ends without a refund to the buyer", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "never-delivered", { disputeId: "MG-DISPUTE-1" });
    await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    ctx.payments.patchDispute("MG-DISPUTE-1", { status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
    expect((await syncIncidentDispute(ctx, getIncident(ctx.db, i.id)!)).status).toBe("closed");
    expect(listLedger(ctx.db)).toHaveLength(0);
  });

  it("without a dispute it refunds the capture directly with one request id", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "never-delivered");
    const done = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(done.status).toBe("done");
    expect(ctx.payments.refunds).toEqual([{ captureId: "MG-CAP-1", amountCents: 2000, key: `mg-refund-${i.id}` }]);
    expect(totalsByAccount(ctx.db).merchant).toBe(-2000);
  });
});

describe("operator at fault: payout, id saved first", () => {
  it("saves sender_batch_id before PayPal is called, pays, and keeps the shop's sale", async () => {
    const ctx = makeCtx();
    const seen: Array<{ rowExistedBeforeSend: boolean; senderBatchId: string }> = [];
    const original = ctx.payments.createPayout.bind(ctx.payments);
    ctx.payments.createPayout = async (input) => {
      const row = ctx.db.prepare("SELECT status FROM payouts WHERE sender_batch_id = ?").get(input.senderBatchId) as { status: string } | undefined;
      seen.push({ rowExistedBeforeSend: row?.status === "prepared", senderBatchId: input.senderBatchId });
      return original(input);
    };
    const i = await proposed(ctx, "wrong-edition");
    const res = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(seen).toHaveLength(1);
    expect(seen[0].rowExistedBeforeSend).toBe(true);
    expect(res.status).toBe("payout_sent"); // the mock needs a second look before the item is SUCCESS

    await workerTick(ctx);
    const done = getIncident(ctx.db, i.id)!;
    expect(done.status).toBe("done");
    expect(getPayoutForIncident(ctx.db, i.id)!.status).toBe("success");
    const entries = listLedger(ctx.db);
    expect(totalsByAccount(ctx.db)).toEqual({ merchant: 0, operator: -1500, buyer: 1500 });
    expect(entries.find((e) => e.account === "operator")!.label).toMatch(/same PayPal balance/);
    expect(entries.find((e) => e.kind === "sale_retained")).toBeTruthy();
  });

  it("after a timeout the retry reuses the same sender_batch_id and finds the existing batch, paying once", async () => {
    const ctx = makeCtx();
    ctx.payments.failNextPayoutCreateAfterProcessing = true;
    const i = await proposed(ctx, "wrong-edition");
    const first = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(first.status).toBe("unknown");
    const row = getPayoutForIncident(ctx.db, i.id)!;
    expect(row.status).toBe("unknown");

    await workerTick(ctx); // resends the same ids, PayPal says duplicate, the app looks the batch up
    await workerTick(ctx);
    const after = getIncident(ctx.db, i.id)!;
    expect(after.status).toBe("done");
    expect(ctx.payments.payoutsBySenderBatch.size).toBe(1);
    expect(getPayoutForIncident(ctx.db, i.id)!.senderBatchId).toBe(row.senderBatchId);
    expect(listAudit(ctx.db).some((a) => a.event === "payout_duplicate_lookup")).toBe(true);
    expect(totalsByAccount(ctx.db).buyer).toBe(1500);
  });

  it("calling the executor again never creates a second payout row or a new id", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    const first = getPayoutForIncident(ctx.db, i.id)!;
    await executeIncident(ctx, i.id);
    await executeIncident(ctx, i.id);
    expect(getPayoutForIncident(ctx.db, i.id)!.senderBatchId).toBe(first.senderBatchId);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM payouts").get() as { n: number }).n).toBe(1);
  });

  it("does not pay while the buyer has an open dispute on the same purchase", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition", { disputeId: "MG-DISPUTE-1" });
    // The rule already refuses at proposal time because the dispute is open.
    expect(i.status).toBe("needs_person");
    expect(ctx.payments.payoutsBySenderBatch.size).toBe(0);
  });

  it("a purchase with no buyer email cannot be paid out and nothing is sent", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition", { buyerEmail: null });
    const res = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(res.status).toBe("failed");
    expect(ctx.payments.payoutsBySenderBatch.size).toBe(0);
  });
});

describe("customer claim not supported: defend", () => {
  it("prepares evidence from verified quotes only, sends it, and moves no money", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "false-claim", { disputeId: "MG-DISPUTE-3" });
    expect(i.remedy).toBe("defend");
    const done = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(done.status).toBe("done");
    expect(ctx.payments.evidence).toHaveLength(1);
    expect(ctx.payments.evidence[0].notes).toContain("File downloaded twice from the buyer's address");
    expect(totalsByAccount(ctx.db)).toEqual({ merchant: 0, operator: 0, buyer: 0 });
    expect(ctx.payments.offers).toHaveLength(0);
    expect(ctx.payments.payoutsBySenderBatch.size).toBe(0);
  });

  it("sends the evidence as a message when only send_message is open", async () => {
    const ctx = makeCtx();
    ctx.payments.patchDispute("MG-DISPUTE-3", { allowedActions: ["send_message"] });
    const i = await proposed(ctx, "false-claim", { disputeId: "MG-DISPUTE-3" });
    const res = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(res.status).toBe("done");
    expect(ctx.payments.evidence).toHaveLength(0);
    expect(ctx.payments.messages).toHaveLength(1);
    expect(ctx.payments.messages[0].message).toContain("downloaded twice");
  });

  it("keeps the evidence ready, and sends nothing, when PayPal opens neither action", async () => {
    const ctx = makeCtx();
    ctx.payments.patchDispute("MG-DISPUTE-3", { allowedActions: [] });
    const i = await proposed(ctx, "false-claim", { disputeId: "MG-DISPUTE-3" });
    const res = await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    expect(res.status).toBe("evidence_ready");
    expect(res.evidenceNote).toContain("downloaded twice");
    expect(ctx.payments.evidence).toHaveLength(0);
    expect(ctx.payments.messages).toHaveLength(0);
  });

  it("sends nothing before the owner approves", async () => {
    const ctx = makeCtx();
    await proposed(ctx, "false-claim", { disputeId: "MG-DISPUTE-3" });
    await workerTick(ctx);
    expect(ctx.payments.evidence).toHaveLength(0);
    expect(ctx.payments.messages).toHaveLength(0);
  });

  it("does not send evidence into a dispute that is already closed", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "false-claim", { disputeId: "MG-DISPUTE-3" });
    ctx.payments.patchDispute("MG-DISPUTE-3", { status: "RESOLVED" });
    expect((await approveIncident(ctx, i.id, i.approvalHash!, OWNER)).status).toBe("closed");
    expect(ctx.payments.evidence).toHaveLength(0);
  });
});

describe("append-only tables", () => {
  it("refuses edits and deletes on the audit log and the ledger", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    await workerTick(ctx);
    expect(() => ctx.db.prepare("UPDATE audit_log SET actor = 'x'").run()).toThrow(/append only/);
    expect(() => ctx.db.prepare("DELETE FROM audit_log").run()).toThrow(/append only/);
    expect(() => ctx.db.prepare("UPDATE ledger_entries SET amount_cents = 1").run()).toThrow(/append only/);
    expect(() => ctx.db.prepare("DELETE FROM ledger_entries").run()).toThrow(/append only/);
  });

  it("writes one settlement per incident even if asked twice", async () => {
    const ctx = makeCtx();
    const i = await proposed(ctx, "wrong-edition");
    await approveIncident(ctx, i.id, i.approvalHash!, OWNER);
    await workerTick(ctx);
    const { settle } = await import("../server/domain/ledger.js");
    settle(ctx.db, i.id, "operator_payout", 1500, "again");
    expect(listLedger(ctx.db).filter((e) => e.account === "operator")).toHaveLength(1);
  });
});

describe("the worker", () => {
  it("proposes new incidents on its own and stops at the owner", async () => {
    const ctx = makeCtx();
    seedFixture(ctx, "never-delivered");
    seedFixture(ctx, "ambiguous");
    const r = await workerTick(ctx);
    expect(r.proposed).toBe(2);
    const statuses = (ctx.db.prepare("SELECT status FROM incidents ORDER BY created_at").all() as Array<{ status: string }>).map((x) => x.status).sort();
    expect(statuses).toEqual(["needs_evidence", "needs_owner"]);
    expect(ctx.payments.offers).toHaveLength(0);
    expect(ctx.payments.refunds).toHaveLength(0);
  });
});
