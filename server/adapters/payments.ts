export type OrderSnapshot = {
  mode: "mock" | "sandbox";
  orderId: string;
  status: string;
  amountCents: number;
  currency: string;
  captureId: string | null;
  captureStatus: string | null;
};

export type DisputeSummary = {
  disputeId: string;
  reason: string;
  status: string;
  stage: string | null;
  state: string | null;
  amountCents: number;
  currency: string;
  transactionId: string | null;
  /** Link relations PayPal says are open to the seller right now, for example make_offer. */
  allowedActions: string[];
  /** Offer types PayPal allows right now. In the one sandbox run this was REFUND only. */
  offerTypes: string[];
  /** For example RESOLVED_BUYER_FAVOUR. Null until resolved. */
  outcome: string | null;
  refundedCents: number | null;
};

export type RefundResult = {
  mode: "mock" | "sandbox";
  refundId: string;
  status: string;
  outcome: "confirmed" | "pending" | "failed" | "unknown";
};

export type OfferResult = { mode: "mock" | "sandbox"; outcome: "made" | "unknown" };

export type PayoutCreateResult = {
  /** created: PayPal took it. duplicate: PayPal says this sender_batch_id already exists. unknown: no answer, may have gone through. */
  outcome: "created" | "duplicate" | "unknown";
  paypalBatchId: string | null;
  batchStatus: string | null;
};

export type PayoutItemStatus = {
  batchStatus: string;
  /** success, pending or failed. The item is what counts, the batch status can lag behind it. */
  item: "success" | "pending" | "failed";
  rawItemStatus: string;
  paypalItemId: string | null;
  transactionId: string | null;
  errorName: string | null;
};

export type FoundRefund = { refundId: string; status: string; amountCents: number };

export type EvidenceResult = { mode: "mock" | "sandbox"; outcome: "sent" | "unknown" };
export type MessageResult = { mode: "mock" | "sandbox"; outcome: "sent" | "unknown" };

export interface PaymentsAdapter {
  readonly mode: "mock" | "sandbox";
  readonly modeLabel: string;
  getOrder(orderId: string): Promise<OrderSnapshot>;
  /** Read-only. The newest COMPLETED refund on the order for this amount, or null. Used to show the refund id after PayPal settled a dispute. */
  findRefund(input: { orderId: string; amountCents: number }): Promise<FoundRefund | null>;
  executeRefund(input: { incidentId: string; amountCents: number; captureId: string; idempotencyKey: string }): Promise<RefundResult>;
  listDisputes(): Promise<DisputeSummary[]>;
  getDispute(disputeId: string): Promise<DisputeSummary>;
  /** Make a refund offer. The buyer still has to accept it inside PayPal. There is deliberately no accept call here. */
  makeOffer(input: { disputeId: string; amountCents: number; note: string; idempotencyKey: string }): Promise<OfferResult>;
  /** Owner-approved only. Needs "provide_evidence" to be open on the dispute. Not yet run against the real sandbox. */
  provideEvidence(input: { disputeId: string; notes: string; idempotencyKey: string }): Promise<EvidenceResult>;
  /** Owner-approved only. Needs "send_message" to be open on the dispute. Sending a message gives the turn to the buyer. Not yet run against the real sandbox. */
  sendMessage(input: { disputeId: string; message: string; idempotencyKey: string }): Promise<MessageResult>;
  createPayout(input: {
    senderBatchId: string;
    senderItemId: string;
    requestId: string;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }): Promise<PayoutCreateResult>;
  getPayoutBatch(paypalBatchId: string): Promise<PayoutItemStatus>;
}

export class NotImplementedYetError extends Error {
  constructor(what: string) {
    super(`${what} is not built yet`);
    this.name = "NotImplementedYetError";
  }
}
