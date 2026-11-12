import type { BundleRecord, Decision, Fault, FaultProposal, Remedy, RecordKind, RuleCheck, StopKind } from "../types.js";
import { buildEvidenceRequests, judgeSupports, unaddressedContradictions, type JudgeChecked } from "./judge.js";
import { messageWarnings } from "./injection.js";
import type { Policy } from "./policy.js";

/** Lowercase, straighten quotes, collapse spaces, drop edge punctuation. Nothing else is forgiven. */
export function normalizeQuote(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:!?"']+|[\s.,;:!?"']+$/g, "")
    .trim();
}

export const MIN_QUOTE_CHARS = 12;

export type QuoteVerdict = { recordId: string; quote: string; ok: boolean; reason: string };

export function verifyQuotes(proposal: FaultProposal, records: BundleRecord[]): QuoteVerdict[] {
  return proposal.citations.map((c) => {
    const rec = records.find((r) => r.id === c.recordId);
    if (!rec) return { recordId: c.recordId, quote: c.quote, ok: false, reason: "No such record." };
    const q = normalizeQuote(c.quote);
    if (q.length < MIN_QUOTE_CHARS) return { recordId: c.recordId, quote: c.quote, ok: false, reason: "Quote is too short to count." };
    if (!normalizeQuote(rec.text).includes(q)) return { recordId: c.recordId, quote: c.quote, ok: false, reason: "These words are not in that record." };
    return { recordId: c.recordId, quote: c.quote, ok: true, reason: "Found word for word." };
  });
}

const REQUIRED_KINDS: Record<Exclude<Fault, "unclear">, { any: RecordKind[]; also?: RecordKind[]; text: string }> = {
  merchant: { any: ["listing", "tracking", "delivery"], text: "the shop's listing, log or delivery record" },
  operator: { any: ["instruction", "mandate"], also: ["cart", "delivery", "listing"], text: "what the buyer asked for and what the agent bought" },
  customer: { any: ["delivery", "tracking"], text: "the delivery or fulfilment record" },
};

const REMEDY_FOR: Record<Exclude<Fault, "unclear">, Remedy> = {
  merchant: "merchant_refund",
  operator: "operator_payout",
  customer: "defend",
};

export type DecideInput = {
  proposal: FaultProposal;
  records: BundleRecord[];
  purchaseAmountCents: number;
  claimedCents: number | null;
  complaint: string;
  policy: Policy;
  /** True when the buyer already has an open dispute on this purchase. */
  openDisputeOnPurchase: boolean;
  /**
   * The independent judge's checked verdict. A verdict object: the judge's call is required to back the conclusion.
   * null: the judge could not be reached, so nothing is decided. undefined: no judge was asked (only the old before-numbers
   * in the evaluation and a few unit tests use this, the app always asks).
   */
  judge?: JudgeChecked | null;
};

function money(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

/**
 * The fixed rule. It reads the AI proposal as data and decides the remedy and the amount.
 * The AI never supplies an amount. Any failed required check turns the answer into "ask a person".
 */
export function decide(input: DecideInput): Decision {
  const { proposal, records, policy } = input;
  const checks: RuleCheck[] = [];
  const add = (id: string, label: string, passed: boolean, detail: string) => checks.push({ id, label, passed, detail });

  const decided = proposal.fault !== "unclear";
  add("fault_decided", "The AI named a side", decided, decided ? `Fault: ${proposal.fault}.` : "The AI said the records do not settle it.");

  add(
    "confidence",
    `Confidence is at least ${Math.round(policy.minConfidence * 100)}%`,
    proposal.confidence >= policy.minConfidence,
    `The AI reported ${Math.round(proposal.confidence * 100)}%.`,
  );

  const hasCites = proposal.citations.length > 0;
  add("has_citations", "At least one quote from the records", hasCites, hasCites ? `${proposal.citations.length} quoted.` : "Nothing was quoted.");

  const verdicts = verifyQuotes(proposal, records);
  const allOk = hasCites && verdicts.every((v) => v.ok);
  add(
    "quotes_verbatim",
    "Every quote appears word for word in the record it cites",
    allOk,
    verdicts.length === 0
      ? "Nothing to check."
      : verdicts.map((v) => `${v.recordId}: ${v.ok ? "found" : v.reason}`).join(" "),
  );

  if (decided) {
    const need = REQUIRED_KINDS[proposal.fault as Exclude<Fault, "unclear">];
    const kinds = new Set(
      verdicts
        .filter((v) => v.ok)
        .map((v) => records.find((r) => r.id === v.recordId)?.kind)
        .filter(Boolean) as RecordKind[],
    );
    const hit = need.any.some((k) => kinds.has(k)) && (!need.also || need.also.some((k) => kinds.has(k)));
    add("right_evidence", "The quotes come from the records that matter for this kind of fault", hit, hit ? "Yes." : `Needs a verified quote from ${need.text}.`);
  } else {
    add("right_evidence", "The quotes come from the records that matter for this kind of fault", false, "No side was named.");
  }

  const remedyIfPassed: Remedy | null = decided ? REMEDY_FOR[proposal.fault as Exclude<Fault, "unclear">] : null;
  const noDoublePay = !(remedyIfPassed === "operator_payout" && input.openDisputeOnPurchase);
  add(
    "no_double_pay",
    "No payout to the buyer while a dispute on the same purchase is open",
    noDoublePay,
    noDoublePay ? "Clear." : "The buyer has an open dispute. Settle it in PayPal first so the buyer is not paid twice.",
  );

  const useJudge = input.judge !== undefined;
  if (useJudge && decided) {
    const sup = judgeSupports(input.judge ?? null);
    add("judge_supports", "An independent judge says the quotes support the conclusion", sup.ok, sup.detail);
    const open = unaddressedContradictions(input.judge ?? null);
    add(
      "no_contradiction",
      "No record the AI ignored points the other way",
      open.length === 0 && input.judge !== null,
      input.judge === null
        ? "The judge could not be reached."
        : open.length === 0
          ? "Nothing found that the AI left out."
          : open.map((c) => `${c.recordId}: "${c.quote.slice(0, 80)}". ${c.why}`).join(" "),
    );
  }

  const warnings = messageWarnings(input.complaint);
  add("complaint_text", "The complaint text does not try to steer the process", warnings.length === 0, warnings.length ? warnings.join(" ") : "Nothing odd found. This check is advisory.");

  const required = ["fault_decided", "confidence", "has_citations", "quotes_verbatim", "right_evidence", "no_double_pay", ...(useJudge ? ["judge_supports", "no_contradiction"] : [])];
  const failed = checks.find((c) => required.includes(c.id) && !c.passed);
  if (failed || !remedyIfPassed) {
    // More records can settle a thin or contradicted case. A double payment risk or a broken answer needs a person.
    const failedIds = new Set(checks.filter((c) => required.includes(c.id) && !c.passed).map((c) => c.id));
    let absentNeeded: RecordKind[] = [];
    if (decided && failedIds.has("right_evidence")) {
      const need = REQUIRED_KINDS[proposal.fault as Exclude<Fault, "unclear">];
      const present = new Set(records.map((r) => r.kind));
      if (!need.any.some((k) => present.has(k))) absentNeeded = need.any;
      else if (need.also && !need.also.some((k) => present.has(k))) absentNeeded = need.also;
    }
    const evidenceRequests = failedIds.has("no_double_pay") ? [] : buildEvidenceRequests({ records, judge: input.judge ?? null, absentNeeded });
    const stop: StopKind = evidenceRequests.length > 0 ? "need_evidence" : "ask_person";
    return {
      remedy: "abstain",
      fault: proposal.fault,
      amountCents: 0,
      confidence: proposal.confidence,
      capped: false,
      abstainReason: failed ? `${failed.label}: ${failed.detail}` : "No remedy applies.",
      checks,
      warnings,
      stop,
      evidenceRequests,
    };
  }

  const base = Math.min(input.claimedCents ?? input.purchaseAmountCents, input.purchaseAmountCents);
  let amountCents = 0;
  let capped = false;
  if (remedyIfPassed === "merchant_refund") {
    amountCents = Math.min(base, policy.merchantRefundCapCents);
    capped = amountCents < base;
  } else if (remedyIfPassed === "operator_payout") {
    amountCents = Math.min(base, policy.operatorGuaranteeCapCents);
    capped = amountCents < base;
  }
  add(
    "amount_from_policy",
    "The amount comes from the capped policy, not from the AI",
    true,
    remedyIfPassed === "defend"
      ? "No money moves for a defended claim."
      : `${money(amountCents)}${capped ? ` (capped from ${money(base)})` : ""}.`,
  );

  return {
    remedy: remedyIfPassed,
    fault: proposal.fault,
    amountCents,
    confidence: proposal.confidence,
    capped,
    abstainReason: null,
    checks,
    warnings,
  };
}
