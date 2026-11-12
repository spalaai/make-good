import type { BundleRecord, EvidenceRequest, FaultProposal, RecordKind } from "../types.js";
import type { JudgeVerdict } from "./judgeSchema.js";
import { normalizeQuote, MIN_QUOTE_CHARS } from "./rules.js";

export type QuoteRole = "supports" | "background" | "does_not_support" | "not_judged";

/** The judge's answer after the app's own checks. The judge never has the last word: a contradiction only counts when its quote is really in the record. */
export type JudgeChecked = {
  /** One entry per quote the proposer cited, in the proposer's order. A quote the judge skipped is "not_judged" and does not count as supporting. */
  quoteChecks: Array<{ recordId: string; quote: string; role: QuoteRole; reason: string }>;
  contradictions: Array<{ recordId: string; quote: string; why: string; addressed: boolean; verified: boolean }>;
  overall: JudgeVerdict["overall"];
  missing: JudgeVerdict["missing"];
  reasoning: string;
};

/** The prompt labels records like "[r5]", and the judge sometimes echoes the brackets. Match on the bare id. */
export function bareId(id: string): string {
  return id.trim().replace(/^[\[\(\s]+|[\]\)\s]+$/g, "").toLowerCase();
}

const WORST: Record<QuoteRole, number> = { supports: 0, background: 1, not_judged: 2, does_not_support: 3 };

export function checkJudge(proposal: FaultProposal, records: BundleRecord[], v: JudgeVerdict): JudgeChecked {
  const quoteChecks = proposal.citations.map((c) => {
    const nq = normalizeQuote(c.quote);
    const hits = v.quotes.filter((j) => {
      if (bareId(j.recordId) !== bareId(c.recordId)) return false;
      const nj = normalizeQuote(j.quote);
      return nj === nq || (nj.length >= MIN_QUOTE_CHARS && nq.length >= MIN_QUOTE_CHARS && (nj.includes(nq) || nq.includes(nj)));
    });
    if (hits.length === 0) return { recordId: c.recordId, quote: c.quote, role: "not_judged" as QuoteRole, reason: "The judge did not rule on this quote." };
    const worst = hits.reduce((a, b) => (WORST[b.role] > WORST[a.role] ? b : a));
    return { recordId: c.recordId, quote: c.quote, role: worst.role as QuoteRole, reason: worst.reason };
  });
  const contradictions = v.contradictions.map((x) => {
    const rec = records.find((r) => bareId(r.id) === bareId(x.recordId));
    const q = normalizeQuote(x.quote);
    const verified = !!rec && q.length >= MIN_QUOTE_CHARS && normalizeQuote(rec.text).includes(q);
    return { recordId: rec?.id ?? x.recordId, quote: x.quote, why: x.why, addressed: x.addressed, verified };
  });
  return { quoteChecks, contradictions, overall: v.overall, missing: v.missing, reasoning: v.reasoning };
}

/** The judge backs the conclusion only when it ruled on every cited quote, none fails to support it, at least one really supports it, and the overall call is "holds". */
export function judgeSupports(j: JudgeChecked | null): { ok: boolean; detail: string } {
  if (!j) return { ok: false, detail: "The judge could not be reached, and nothing is decided without it." };
  const bad = j.quoteChecks.find((q) => q.role === "does_not_support");
  if (bad) return { ok: false, detail: `${bad.recordId}: "${bad.quote.slice(0, 80)}" does not support the conclusion. ${bad.reason}` };
  const skipped = j.quoteChecks.find((q) => q.role === "not_judged");
  if (skipped) return { ok: false, detail: `${skipped.recordId}: the judge did not rule on this quote.` };
  const n = j.quoteChecks.filter((q) => q.role === "supports").length;
  if (n === 0) return { ok: false, detail: "No cited quote actually supports the conclusion." };
  if (j.overall !== "holds") return { ok: false, detail: `The judge calls the conclusion ${j.overall}. ${j.reasoning.slice(0, 200)}` };
  return { ok: true, detail: `${n} of ${j.quoteChecks.length} quotes support it, the rest are background. The judge says it holds.` };
}

/** Contradicting records the proposer did not deal with. Only quotes found word for word in the record count. */
export function unaddressedContradictions(j: JudgeChecked | null): JudgeChecked["contradictions"] {
  return (j?.contradictions ?? []).filter((c) => c.verified && !c.addressed);
}

const TITLES: Record<RecordKind, string> = {
  instruction: "What the buyer asked for, in the buyer's own words",
  mandate: "The agent's mandate: what it was allowed to buy",
  listing: "A snapshot of the shop listing at the time of purchase",
  cart: "What the agent actually put in the cart",
  tracking: "The shop's fulfilment log or a carrier scan",
  delivery: "The delivery status or proof of delivery",
};

/** What to ask for: records the judge says would settle it, plus kinds that are simply absent from the bundle where the conclusion needs them. */
export function buildEvidenceRequests(opts: {
  records: BundleRecord[];
  judge: JudgeChecked | null;
  /** Kinds the conclusion needs at least one of, when none of them is in the bundle. */
  absentNeeded: RecordKind[];
}): EvidenceRequest[] {
  const out: EvidenceRequest[] = [];
  const seen = new Set<string>();
  const add = (r: EvidenceRequest) => {
    const key = normalizeQuote(r.title);
    if (seen.has(key) || out.length >= 6) return;
    seen.add(key);
    out.push(r);
  };
  for (const k of opts.absentNeeded) add({ kind: k, title: TITLES[k], why: "The bundle has no record of this kind, and the conclusion needs one." });
  for (const m of opts.judge?.missing ?? []) add({ kind: m.kind, title: m.title, why: m.why });
  return out;
}
