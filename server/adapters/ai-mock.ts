import { fixtureByKey } from "../fixtures.js";
import type { AiAdapter, AiResult, JudgeInput, JudgeResult, ProposeInput } from "./ai.js";
import { normalizeQuote } from "../domain/rules.js";

/** Saved answers for the example purchases. Anything else comes back as "unclear", never as a guess. */
export class MockAiAdapter implements AiAdapter {
  readonly kind = "recorded" as const;
  readonly provider = "recorded";
  readonly model = "saved answers";
  readonly modeLabel = "AI: recorded answers (no live provider configured)";
  readonly fallbackToRecorded = false;

  async proposeFault(input: ProposeInput): Promise<AiResult> {
    const fx = fixtureByKey(input.fixtureKey);
    const source = { kind: "recorded" as const, provider: this.provider, model: this.model };
    // The saved answer belongs to the saved bundle. If the owner added records, it no longer applies and nothing is judged from it.
    if (fx && input.records.length === fx.records.length) return { proposal: fx.recorded, source };
    return {
      proposal: {
        fault: "unclear",
        confidence: 0.2,
        summary: "No saved answer exists for this purchase, so the records are not judged.",
        citations: [],
      },
      source,
    };
  }

  /**
   * The saved verdict is only valid for the saved answer. Any other answer (an altered one, an unknown purchase) gets a verdict that does not back it:
   * the judge fails closed.
   */
  async judgeEvidence(input: JudgeInput): Promise<JudgeResult> {
    const fx = fixtureByKey(input.fixtureKey);
    const source = { kind: "recorded" as const, provider: this.provider, model: this.model };
    const same =
      fx &&
      input.records.length === fx.records.length &&
      fx.recorded.fault === input.proposal.fault &&
      fx.recorded.citations.length === input.proposal.citations.length &&
      fx.recorded.citations.every((c, i) => c.recordId === input.proposal.citations[i].recordId && normalizeQuote(c.quote) === normalizeQuote(input.proposal.citations[i].quote));
    if (fx && same) return { verdict: fx.recordedJudge, source };
    return {
      verdict: { quotes: [], contradictions: [], overall: "weak", missing: [], reasoning: "There is no saved verdict for this answer, so it is not judged as backed." },
      source,
    };
  }
}
