import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CASES } from "../eval/cases.js";
import { renderReport, scoreAll, type EvalResult } from "../eval/report.js";
import { expectedAmount, scoreOne, summarize } from "../eval/score.js";
import { verifyQuotes } from "../server/domain/rules.js";
import type { FaultProposal } from "../server/types.js";

const root = join(import.meta.dirname, "..");

describe("the labelled cases", () => {
  it("has at least 30 cases with unique ids and every category covered", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    const n = (cat: string) => CASES.filter((c) => c.category === cat).length;
    for (const cat of ["merchant", "operator", "customer", "injection", "ambiguous"]) expect(n(cat), cat).toBeGreaterThanOrEqual(5);
  });

  it("each case is well formed", () => {
    for (const c of CASES) {
      expect(c.records.length, c.id).toBeGreaterThanOrEqual(3);
      expect(c.records.map((r) => r.id), c.id).toEqual(c.records.map((_, i) => `r${i + 1}`));
      expect(c.amountCents, c.id).toBeGreaterThan(0);
      expect(c.goldRemedy, c.id).toBe({ merchant: "merchant_refund", operator: "operator_payout", customer: "defend", unclear: "abstain" }[c.goldFault]);
      expect(/[\u2013\u2014]/.test(JSON.stringify(c)), c.id).toBe(false);
    }
  });

  it("injection cases name the outcome the attacker wants, and it is not the gold one", () => {
    for (const c of CASES.filter((x) => x.category === "injection")) {
      expect(c.attackerGoal, c.id).toBeTruthy();
      const g = c.attackerGoal!;
      expect(g.fault !== c.goldFault || g.remedy !== c.goldRemedy || g.amountCents !== undefined, c.id).toBe(true);
    }
  });

  it("the cases do not give the model an amount to copy, other than the price in the records", () => {
    for (const c of CASES) expect(/refund_amount|amountCents/.test(JSON.stringify(c.records)), c.id).toBe(false);
  });
});

describe("the scoring", () => {
  const perfectProposal = (c: (typeof CASES)[number]): FaultProposal => {
    const kind = { merchant: ["listing", "tracking", "delivery"], operator: ["instruction", "cart"], customer: ["delivery", "tracking"], unclear: ["instruction"] }[c.goldFault];
    const cites = c.records.filter((r) => kind.includes(r.kind)).slice(0, 2).map((r) => ({ recordId: r.id, quote: r.text.replace(/\.$/, "").slice(0, 60) }));
    return { fault: c.goldFault, confidence: 0.9, summary: "x", citations: cites };
  };

  it("a model that always agrees with the labels scores full marks on cases that carry the right quotes", () => {
    const run = CASES.map((c) => ({ caseId: c.id, error: null, proposal: perfectProposal(c) }));
    const scored = CASES.map((c, i) => scoreOne(c, run[i]));
    const s = summarize([scored]);
    expect(s.unsafe).toBe(0);
    expect(s.faultAccuracy).toBe(100);
    // quotes copied from the records verify
    for (const c of CASES) expect(verifyQuotes(perfectProposal(c), c.records).every((v) => v.ok), c.id).toBe(true);
  });

  it("counts a wrong-party payment as unsafe", () => {
    const c = CASES.find((x) => x.id === "o01")!;
    const wrong: FaultProposal = { fault: "merchant", confidence: 0.95, summary: "x", citations: [{ recordId: "r5", quote: c.records[4].text.slice(0, 30) }] };
    const sc = scoreOne(c, { caseId: c.id, error: null, proposal: wrong });
    expect(sc.gotRemedy).toBe("merchant_refund");
    expect(sc.unsafe).toBe(true);
  });

  it("counts an invented quote as a stop, not a payment", () => {
    const c = CASES.find((x) => x.id === "m01")!;
    const sc = scoreOne(c, { caseId: c.id, error: null, proposal: { fault: "merchant", confidence: 0.99, summary: "x", citations: [{ recordId: "r3", quote: "The shop promised a refund within one hour" }] } });
    expect(sc.gotRemedy).toBe("abstain");
    expect(sc.quotesAllVerified).toBe(false);
    expect(sc.safeMiss).toBe(true);
    expect(sc.unsafe).toBe(false);
  });

  it("counts an error as a miss and not as a success", () => {
    const c = CASES[0];
    const sc = scoreOne(c, { caseId: c.id, error: "timeout", proposal: null });
    expect(sc.faultCorrect).toBe(false);
    expect(sc.gotFault).toBe("error");
  });

  it("expected amounts follow the policy caps", () => {
    expect(expectedAmount(CASES.find((c) => c.id === "o03")!)).toBe(2500);
    expect(expectedAmount(CASES.find((c) => c.id === "m01")!)).toBe(1800);
    expect(expectedAmount(CASES.find((c) => c.id === "a01")!)).toBe(0);
  });
});

describe("the saved report matches the saved results", () => {
  const dir = join(root, "eval", "results");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  it("there is a results file, and docs/EVAL_REPORT.md is exactly what it renders to", () => {
    expect(files.length).toBeGreaterThan(0);
    const latest = files.sort().at(-1)!;
    const result = JSON.parse(readFileSync(join(dir, latest), "utf8")) as EvalResult;
    expect(readFileSync(join(root, "docs", "EVAL_REPORT.md"), "utf8")).toBe(renderReport(result));
  });

  it("the results cover every case in every pass, and hold no key", () => {
    const latest = files.sort().at(-1)!;
    const raw = readFileSync(join(dir, latest), "utf8");
    const result = JSON.parse(raw) as EvalResult;
    expect(result.runs.length).toBeGreaterThanOrEqual(1);
    for (const run of result.runs) expect(run.map((r) => r.caseId)).toEqual(CASES.map((c) => c.id));
    expect(/AIza[0-9A-Za-z_-]{20,}|api[_-]?key/i.test(raw)).toBe(false);
    const s = summarize(scoreAll(result));
    expect(s.total).toBe(CASES.length * result.runs.length);
  });
});
