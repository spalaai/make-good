import {
  type DisputeSummary,
  type EvidenceResult,
  type FoundRefund,
  type MessageResult,
  type OfferResult,
  type OrderSnapshot,
  type PaymentsAdapter,
  type PayoutCreateResult,
  type PayoutItemStatus,
  type RefundResult,
} from "../payments.js";

type MockPayout = { batchId: string; polls: number; receiver: string; amountCents: number };

/**
 * An in-memory PayPal for development and tests. It follows what the two sandbox runs showed:
 * an offer does not resolve a dispute until the buyer accepts it (buyerAccepts stands in for the buyer clicking Accept in PayPal),
 * and a reused sender_batch_id is refused.
 */
export class MockPayPalAdapter implements PaymentsAdapter {
  readonly mode = "mock" as const;
  readonly modeLabel = "Mock PayPal (no network)";
  readonly disputes = new Map<string, DisputeSummary>();
  readonly payoutsBySenderBatch = new Map<string, MockPayout>();
  readonly payoutsByBatchId = new Map<string, MockPayout>();
  readonly offers: Array<{ disputeId: string; amountCents: number; note: string }> = [];
  readonly refunds: Array<{ captureId: string; amountCents: number; key: string }> = [];
  readonly evidence: Array<{ disputeId: string; notes: string }> = [];
  readonly messages: Array<{ disputeId: string; message: string }> = [];
  /** Test switches. */
  failNextPayoutCreateAfterProcessing = false;
  payoutPollsUntilSuccess = 1;
  private n = 0;

  constructor() {
    this.registerDispute({ disputeId: "MG-DISPUTE-1", amountCents: 2000 });
    this.registerDispute({ disputeId: "MG-DISPUTE-3", amountCents: 1800 });
  }

  registerDispute(d: { disputeId: string; amountCents: number; status?: string; allowedActions?: string[] }): void {
    this.disputes.set(d.disputeId, {
      disputeId: d.disputeId,
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: d.status ?? "WAITING_FOR_SELLER_RESPONSE",
      stage: "INQUIRY",
      state: null,
      amountCents: d.amountCents,
      currency: "USD",
      transactionId: null,
      allowedActions: d.allowedActions ?? ["make_offer", "provide_evidence", "send_message"],
      offerTypes: ["REFUND"],
      outcome: null,
      refundedCents: null,
    });
  }

  patchDispute(id: string, patch: Partial<DisputeSummary>): void {
    const d = this.disputes.get(id);
    if (!d) throw new Error("unknown mock dispute");
    this.disputes.set(id, { ...d, ...patch });
  }

  /** Stands in for the buyer accepting the offer on PayPal's page. */
  buyerAccepts(disputeId: string): void {
    const offer = [...this.offers].reverse().find((o) => o.disputeId === disputeId);
    if (!offer) throw new Error("no offer to accept");
    this.patchDispute(disputeId, {
      status: "RESOLVED",
      allowedActions: [],
      offerTypes: [],
      outcome: "RESOLVED_BUYER_FAVOUR",
      refundedCents: offer.amountCents,
    });
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    return { mode: "mock", orderId, status: "COMPLETED", amountCents: 0, currency: "USD", captureId: `CAP-${orderId}`, captureStatus: "COMPLETED" };
  }

  async findRefund(input: { orderId: string; amountCents: number }): Promise<FoundRefund | null> {
    return { refundId: `MOCK-REFUND-${input.orderId}`, status: "COMPLETED", amountCents: input.amountCents };
  }

  async executeRefund(input: { incidentId: string; amountCents: number; captureId: string; idempotencyKey: string }): Promise<RefundResult> {
    const seen = this.refunds.find((r) => r.key === input.idempotencyKey);
    if (!seen) this.refunds.push({ captureId: input.captureId, amountCents: input.amountCents, key: input.idempotencyKey });
    return { mode: "mock", refundId: `MOCK-REFUND-${input.idempotencyKey.slice(-8)}`, status: "COMPLETED", outcome: "confirmed" };
  }

  async listDisputes(): Promise<DisputeSummary[]> {
    return [...this.disputes.values()];
  }

  async getDispute(disputeId: string): Promise<DisputeSummary> {
    const d = this.disputes.get(disputeId);
    if (!d) throw new Error("PayPal get dispute failed: 404");
    return { ...d };
  }

  async makeOffer(input: { disputeId: string; amountCents: number; note: string; idempotencyKey: string }): Promise<OfferResult> {
    const d = this.disputes.get(input.disputeId);
    if (!d || !d.allowedActions.includes("make_offer")) throw new Error("PayPal make offer failed: 422");
    this.offers.push({ disputeId: input.disputeId, amountCents: input.amountCents, note: input.note });
    this.patchDispute(input.disputeId, { status: "WAITING_FOR_BUYER_RESPONSE", allowedActions: [], offerTypes: [] });
    return { mode: "mock", outcome: "made" };
  }

  async provideEvidence(input: { disputeId: string; notes: string; idempotencyKey: string }): Promise<EvidenceResult> {
    const d = this.disputes.get(input.disputeId);
    if (!d || !d.allowedActions.includes("provide_evidence")) throw new Error("PayPal dispute action failed: 422");
    this.evidence.push({ disputeId: input.disputeId, notes: input.notes });
    this.patchDispute(input.disputeId, { status: "UNDER_REVIEW", allowedActions: [] });
    return { mode: "mock", outcome: "sent" };
  }

  async sendMessage(input: { disputeId: string; message: string; idempotencyKey: string }): Promise<MessageResult> {
    const d = this.disputes.get(input.disputeId);
    if (!d || !d.allowedActions.includes("send_message")) throw new Error("PayPal dispute action failed: 422");
    this.messages.push({ disputeId: input.disputeId, message: input.message });
    this.patchDispute(input.disputeId, { status: "WAITING_FOR_BUYER_RESPONSE", allowedActions: [] });
    return { mode: "mock", outcome: "sent" };
  }

  async createPayout(input: {
    senderBatchId: string;
    senderItemId: string;
    requestId: string;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }): Promise<PayoutCreateResult> {
    const existing = this.payoutsBySenderBatch.get(input.senderBatchId);
    if (existing) return { outcome: "duplicate", paypalBatchId: existing.batchId, batchStatus: null };
    const batchId = `MOCKBATCH${++this.n}`;
    const p: MockPayout = { batchId, polls: 0, receiver: input.receiverEmail, amountCents: input.amountCents };
    this.payoutsBySenderBatch.set(input.senderBatchId, p);
    this.payoutsByBatchId.set(batchId, p);
    if (this.failNextPayoutCreateAfterProcessing) {
      this.failNextPayoutCreateAfterProcessing = false;
      return { outcome: "unknown", paypalBatchId: null, batchStatus: null };
    }
    return { outcome: "created", paypalBatchId: batchId, batchStatus: "PENDING" };
  }

  async getPayoutBatch(paypalBatchId: string): Promise<PayoutItemStatus> {
    const p = this.payoutsByBatchId.get(paypalBatchId);
    if (!p) throw new Error("PayPal get payout failed: 404");
    p.polls += 1;
    const done = p.polls > this.payoutPollsUntilSuccess;
    return {
      batchStatus: done ? "SUCCESS" : "PROCESSING",
      item: done ? "success" : "pending",
      rawItemStatus: done ? "SUCCESS" : "PENDING",
      paypalItemId: `MOCKITEM-${paypalBatchId}`,
      transactionId: done ? `MOCKTXN-${paypalBatchId}` : null,
      errorName: null,
    };
  }
}
