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
import { isIndeterminateNetworkError, paypalFetch } from "./http.js";

function moneyToCents(value: string | undefined): number {
  if (!value) return 0;
  return Math.round(parseFloat(value) * 100);
}

function centsToMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function mapDispute(raw: Record<string, unknown>): DisputeSummary {
  const amount = (raw.dispute_amount as { value?: string; currency_code?: string }) ?? {};
  const txns = raw.disputed_transactions as Array<{ seller_transaction_id?: string }> | undefined;
  const options = (raw.allowed_response_options ?? {}) as { make_offer?: { offer_types?: string[] } };
  const outcome = (raw.dispute_outcome ?? {}) as { outcome_code?: string; amount_refunded?: { value?: string } };
  return {
    disputeId: String(raw.dispute_id ?? ""),
    reason: String(raw.reason ?? "other"),
    status: String(raw.status ?? "OPEN"),
    stage: (raw.dispute_life_cycle_stage as string | undefined) ?? null,
    state: (raw.dispute_state as string | undefined) ?? null,
    amountCents: moneyToCents(amount.value),
    currency: String(amount.currency_code ?? "USD"),
    transactionId: txns?.[0]?.seller_transaction_id ?? null,
    allowedActions: Array.isArray(raw.links)
      ? (raw.links as Array<{ rel?: string }>).map((l) => String(l.rel ?? "")).filter((r) => r && r !== "self")
      : [],
    offerTypes: Array.isArray(options.make_offer?.offer_types) ? options.make_offer!.offer_types!.map(String) : [],
    outcome: outcome.outcome_code ?? null,
    refundedCents: outcome.amount_refunded?.value ? moneyToCents(outcome.amount_refunded.value) : null,
  };
}

export function outcomeFromStatus(status: string): RefundResult["outcome"] {
  if (status === "COMPLETED") return "confirmed";
  if (status === "PENDING") return "pending";
  if (status === "FAILED" || status === "CANCELLED") return "failed";
  return "unknown";
}

const ITEM_FAILED = new Set(["FAILED", "DENIED", "RETURNED", "BLOCKED", "CANCELED", "REFUNDED", "REVERSED"]);

export function mapPayoutItem(rawStatus: string): PayoutItemStatus["item"] {
  if (rawStatus === "SUCCESS") return "success";
  if (ITEM_FAILED.has(rawStatus)) return "failed";
  return "pending";
}

export class SandboxPayPalAdapter implements PaymentsAdapter {
  readonly mode = "sandbox" as const;
  readonly modeLabel = "PayPal sandbox (play money)";
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    const res = await paypalFetch(this.fetchImpl, `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (!res.ok) throw new Error(`PayPal get order failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      id: string;
      status: string;
      purchase_units?: Array<{
        amount?: { value?: string; currency_code?: string };
        payments?: { captures?: Array<{ id: string; status: string }> };
      }>;
    };
    const unit = json.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    return {
      mode: "sandbox",
      orderId: json.id,
      status: json.status,
      amountCents: moneyToCents(unit?.amount?.value),
      currency: unit?.amount?.currency_code ?? "USD",
      captureId: capture?.id ?? null,
      captureStatus: capture?.status ?? null,
    };
  }

  async findRefund(input: { orderId: string; amountCents: number }): Promise<FoundRefund | null> {
    const res = await paypalFetch(this.fetchImpl, `/v2/checkout/orders/${encodeURIComponent(input.orderId)}`);
    if (!res.ok) throw new Error(`PayPal get order failed: ${res.status}`);
    const json = (await res.json()) as { purchase_units?: Array<{ payments?: { refunds?: Array<{ id: string; status: string; amount?: { value?: string }; create_time?: string }> } }> };
    const refunds = (json.purchase_units?.[0]?.payments?.refunds ?? [])
      .filter((r) => r.status === "COMPLETED" && moneyToCents(r.amount?.value) === input.amountCents)
      .sort((a, b) => String(b.create_time ?? "").localeCompare(String(a.create_time ?? "")));
    const r = refunds[0];
    return r ? { refundId: r.id, status: r.status, amountCents: input.amountCents } : null;
  }

  async executeRefund(input: { incidentId: string; amountCents: number; captureId: string; idempotencyKey: string }): Promise<RefundResult> {
    const body = {
      amount: { value: centsToMoney(input.amountCents), currency_code: "USD" },
      note_to_payer: `Make Good refund for incident ${input.incidentId}`,
    };
    let res: Response;
    try {
      res = await paypalFetch(this.fetchImpl, `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, {
        method: "POST",
        body: JSON.stringify(body),
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      if (isIndeterminateNetworkError(e)) return { mode: "sandbox", refundId: "", status: "UNKNOWN", outcome: "unknown" };
      throw e;
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { mode: "sandbox", refundId: "", status: "UNKNOWN", outcome: "unknown" };
    }
    if (!res.ok) throw new Error(`PayPal refund failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { id: string; status: string };
    const status = json.status ?? "COMPLETED";
    return { mode: "sandbox", refundId: json.id, status, outcome: outcomeFromStatus(status) };
  }

  async listDisputes(): Promise<DisputeSummary[]> {
    const res = await paypalFetch(this.fetchImpl, "/v1/customer/disputes?page_size=20");
    if (!res.ok) throw new Error(`PayPal list disputes failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { items?: Record<string, unknown>[] };
    return (json.items ?? []).map(mapDispute);
  }

  async getDispute(disputeId: string): Promise<DisputeSummary> {
    const res = await paypalFetch(this.fetchImpl, `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
    if (!res.ok) throw new Error(`PayPal get dispute failed: ${res.status} ${await res.text()}`);
    return mapDispute((await res.json()) as Record<string, unknown>);
  }

  async makeOffer(input: { disputeId: string; amountCents: number; note: string; idempotencyKey: string }): Promise<OfferResult> {
    const body = {
      note: input.note,
      offer_amount: { currency_code: "USD", value: centsToMoney(input.amountCents) },
      offer_type: "REFUND",
    };
    let res: Response;
    try {
      res = await paypalFetch(this.fetchImpl, `/v1/customer/disputes/${encodeURIComponent(input.disputeId)}/make-offer`, {
        method: "POST",
        body: JSON.stringify(body),
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      if (isIndeterminateNetworkError(e)) return { mode: "sandbox", outcome: "unknown" };
      throw e;
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) return { mode: "sandbox", outcome: "unknown" };
    if (!res.ok) throw new Error(`PayPal make offer failed: ${res.status} ${await res.text()}`);
    return { mode: "sandbox", outcome: "made" };
  }

  /**
   * POST provide-evidence with a JSON body (type OTHER, notes only). Written from PayPal's documented shape and covered by
   * tests with a mocked fetch. It has NOT been run against the real sandbox: the one dispute run stayed at the inquiry stage,
   * where PayPal did not offer provide_evidence.
   */
  async provideEvidence(input: { disputeId: string; notes: string; idempotencyKey: string }): Promise<EvidenceResult> {
    return this.postDisputeAction(`/v1/customer/disputes/${encodeURIComponent(input.disputeId)}/provide-evidence`, { evidences: [{ evidence_type: "OTHER", notes: input.notes.slice(0, 2000) }] }, input.idempotencyKey);
  }

  /** POST send-message. Same status as provideEvidence: documented shape, mocked tests, not run against the real sandbox. */
  async sendMessage(input: { disputeId: string; message: string; idempotencyKey: string }): Promise<MessageResult> {
    return this.postDisputeAction(`/v1/customer/disputes/${encodeURIComponent(input.disputeId)}/send-message`, { message: input.message.slice(0, 2000) }, input.idempotencyKey);
  }

  private async postDisputeAction(path: string, body: unknown, idempotencyKey: string): Promise<{ mode: "sandbox"; outcome: "sent" | "unknown" }> {
    let res: Response;
    try {
      res = await paypalFetch(this.fetchImpl, path, { method: "POST", body: JSON.stringify(body), idempotencyKey });
    } catch (e) {
      if (isIndeterminateNetworkError(e)) return { mode: "sandbox", outcome: "unknown" };
      throw e;
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) return { mode: "sandbox", outcome: "unknown" };
    if (!res.ok) throw new Error(`PayPal dispute action failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { mode: "sandbox", outcome: "sent" };
  }

  async createPayout(input: {
    senderBatchId: string;
    senderItemId: string;
    requestId: string;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }): Promise<PayoutCreateResult> {
    const body = {
      sender_batch_header: {
        sender_batch_id: input.senderBatchId,
        email_subject: "Make Good reimbursement",
        email_message: "A reimbursement for a purchase that went wrong.",
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: centsToMoney(input.amountCents), currency: "USD" },
          receiver: input.receiverEmail,
          note: input.note,
          sender_item_id: input.senderItemId,
        },
      ],
    };
    let res: Response;
    try {
      res = await paypalFetch(this.fetchImpl, "/v1/payments/payouts", {
        method: "POST",
        body: JSON.stringify(body),
        idempotencyKey: input.requestId,
      });
    } catch (e) {
      if (isIndeterminateNetworkError(e)) return { outcome: "unknown", paypalBatchId: null, batchStatus: null };
      throw e;
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { outcome: "unknown", paypalBatchId: null, batchStatus: null };
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // keep the empty object
    }
    if (res.ok) {
      const header = (json.batch_header ?? {}) as { payout_batch_id?: string; batch_status?: string };
      return { outcome: "created", paypalBatchId: header.payout_batch_id ?? null, batchStatus: header.batch_status ?? null };
    }
    if (isDuplicateBatchError(res.status, json)) {
      return { outcome: "duplicate", paypalBatchId: batchIdFromLinks(json), batchStatus: null };
    }
    throw new Error(`PayPal payout failed: ${res.status} ${text.slice(0, 300)}`);
  }

  async getPayoutBatch(paypalBatchId: string): Promise<PayoutItemStatus> {
    const res = await paypalFetch(this.fetchImpl, `/v1/payments/payouts/${encodeURIComponent(paypalBatchId)}`);
    if (!res.ok) throw new Error(`PayPal get payout failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      batch_header?: { batch_status?: string };
      items?: Array<{ transaction_status?: string; payout_item_id?: string; transaction_id?: string; errors?: { name?: string } }>;
    };
    const item = json.items?.[0];
    const raw = item?.transaction_status ?? "PENDING";
    return {
      batchStatus: json.batch_header?.batch_status ?? "PENDING",
      item: mapPayoutItem(raw),
      rawItemStatus: raw,
      paypalItemId: item?.payout_item_id ?? null,
      transactionId: item?.transaction_id ?? null,
      errorName: item?.errors?.name ?? null,
    };
  }
}

/** PayPal answers a reused sender_batch_id with 400 USER_BUSINESS_ERROR "Batch with given sender_batch_id already exists". */
export function isDuplicateBatchError(status: number, json: Record<string, unknown>): boolean {
  if (status !== 400) return false;
  const text = JSON.stringify(json).toLowerCase();
  return text.includes("already exists") && text.includes("sender_batch_id");
}

/**
 * The duplicate answer carries a link to the original batch. The sandbox put it at details[0].link[0].href
 * (host api.sandbox.paypal.com), and the top level links array was empty. Both places are read. Null when neither has it.
 */
export function batchIdFromLinks(json: Record<string, unknown>): string | null {
  const hrefs: string[] = [];
  const top = Array.isArray(json.links) ? (json.links as Array<{ href?: string }>) : [];
  for (const l of top) if (l.href) hrefs.push(l.href);
  const details = Array.isArray(json.details) ? (json.details as Array<{ link?: Array<{ href?: string }>; links?: Array<{ href?: string }> }>) : [];
  for (const d of details) for (const l of [...(d.link ?? []), ...(d.links ?? [])]) if (l.href) hrefs.push(l.href);
  for (const h of hrefs) {
    const m = /\/v1\/payments\/payouts\/([A-Za-z0-9]+)(?:[/?]|$)/.exec(h);
    if (m) return m[1];
  }
  return null;
}
