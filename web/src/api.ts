export type Session = { token: string; username: string; role: "owner" | "agent" };

const KEY = "make-good-session";

export function getSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
  } catch {
    return null;
  }
}
export function setSession(s: Session | null): void {
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
}

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const s = getSession();
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) setSession(null);
  if (!res.ok) throw new Error((json as { error?: string }).error ?? "Something went wrong. Nothing was changed.");
  return json as T;
}

/** Dollar text for the console. No minus sign and no dash: a negative amount reads "minus $20.00" (the console font draws a lone hyphen like a long dash). */
export const money = (cents: number): string => `${cents < 0 ? "minus " : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
/** The ledger as words: who received and who paid. */
export const moneyFlow = (cents: number): string => `${cents < 0 ? "paid" : "received"} $${(Math.abs(cents) / 100).toFixed(2)}`;

export type BundleRecord = { id: string; kind: string; label: string; text: string; addedBy?: string; addedAt?: string };
export type Quote = { recordId: string; quote: string; ok: boolean; reason: string };
export type RuleCheck = { id: string; label: string; passed: boolean; detail: string };
export type EvidenceRequest = { kind: string; title: string; why: string };
export type JudgeView = {
  quoteChecks: Array<{ recordId: string; quote: string; role: "supports" | "background" | "does_not_support" | "not_judged"; reason: string }>;
  contradictions: Array<{ recordId: string; quote: string; why: string; addressed: boolean; verified: boolean }>;
  overall: "holds" | "weak" | "fails";
  missing: Array<{ kind: string; title: string; why: string }>;
  reasoning: string;
};
export type Incident = {
  id: string;
  status: string;
  complaint: string;
  remedy: string | null;
  amountCents: number | null;
  disputeId: string | null;
  refundId: string | null;
  disputeStatus: string | null;
  error: string | null;
  approvalToken: string | null;
  paymentsMode: "mock" | "sandbox";
  createdAt: string;
  proposal: { fault: string; confidence: number; summary: string; citations: Array<{ recordId: string; quote: string }> } | null;
  aiSource: { kind: string; provider: string; model: string; note?: string } | null;
  decision: { remedy: string; capped: boolean; abstainReason: string | null; checks: RuleCheck[]; warnings: string[]; stop?: "ask_person" | "need_evidence" | null; evidenceRequests?: EvidenceRequest[] } | null;
  judge: JudgeView | null;
  judgeSource: { kind: string; provider: string; model: string; note?: string } | null;
  approvedBy: string | null;
  evidenceNote: string | null;
  evidencePreview: string | null;
  quotes: Quote[];
  purchase: { id: string; orderId: string; captureId: string | null; amountCents: number; merchantName: string; operatorName: string; buyerEmail: string | null; records: BundleRecord[] };
  payout: { senderBatchId: string; status: string; paypalBatchId: string | null; paypalItemId: string | null; transactionId: string | null } | null;
  ledger: Array<{ id: string; account: string; amountCents: number; kind: string; ref: string | null; label: string }>;
};

export const STATUS_TEXT: Record<string, string> = {
  new: "Waiting for the agent",
  analyzing: "Reading the records",
  needs_owner: "Waiting for your approval",
  needs_person: "Needs a person to decide",
  needs_evidence: "Needs more records",
  approved: "Approved",
  executing: "Working",
  waiting_paypal: "Waiting for PayPal to open the shop's turn",
  offer_made: "Offer made, waiting for the buyer to accept in PayPal",
  payout_sent: "Payout sent, waiting for PayPal to confirm",
  evidence_ready: "Evidence ready, not sent",
  done: "Settled",
  closed: "Closed without a payment",
  rejected: "Rejected",
  unknown: "PayPal did not answer, check before retrying",
  failed: "Did not complete, nothing was paid",
};

export const REMEDY_TEXT: Record<string, string> = {
  merchant_refund: "Shop refunds the buyer",
  operator_payout: "Operator reimburses the buyer, shop keeps the sale",
  defend: "Defend the claim with the shop's records",
  abstain: "Ask a person",
};

export const FAULT_TEXT: Record<string, string> = {
  merchant: "The shop",
  operator: "The agent's operator",
  customer: "The claim is not supported",
  unclear: "Unclear",
};
