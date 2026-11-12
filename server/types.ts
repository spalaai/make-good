export type RecordKind = "instruction" | "mandate" | "listing" | "cart" | "tracking" | "delivery";

/** One line item of the receipt bundle. The AI may only quote these, word for word. */
export type BundleRecord = {
  id: string;
  kind: RecordKind;
  label: string;
  text: string;
  /** Set on a record the owner attached after the first proposal. The original records never carry it. */
  addedBy?: string;
  addedAt?: string;
};

export type Fault = "merchant" | "operator" | "customer" | "unclear";
export type Remedy = "merchant_refund" | "operator_payout" | "defend" | "abstain";

export type Citation = { recordId: string; quote: string };

/** What the AI is allowed to say. There is no amount field on purpose: money comes from the fixed rule. */
export type FaultProposal = {
  fault: Fault;
  confidence: number;
  summary: string;
  citations: Citation[];
};

export type RuleCheck = { id: string; label: string; passed: boolean; detail: string };

/** A record that would settle the case and is not in the bundle. "other" is for things like a carrier scan. */
export type EvidenceRequest = { kind: RecordKind | "other"; title: string; why: string };

/** Why the rule stopped. "need_evidence" means more records could settle it, "ask_person" means a person has to decide. */
export type StopKind = "ask_person" | "need_evidence";

export type Decision = {
  remedy: Remedy;
  fault: Fault;
  amountCents: number;
  confidence: number;
  capped: boolean;
  abstainReason: string | null;
  checks: RuleCheck[];
  warnings: string[];
  /** Set only when remedy is "abstain". */
  stop?: StopKind | null;
  /** The specific records to ask for when stop is "need_evidence". */
  evidenceRequests?: EvidenceRequest[];
};

export type IncidentStatus =
  | "new"
  | "analyzing"
  | "needs_owner"
  | "needs_person"
  | "needs_evidence"
  | "approved"
  | "executing"
  | "waiting_paypal"
  | "offer_made"
  | "payout_sent"
  | "evidence_ready"
  | "done"
  | "closed"
  | "rejected"
  | "unknown"
  | "failed";

export type Role = "agent" | "owner";
