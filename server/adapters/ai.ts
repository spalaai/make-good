import type { BundleRecord, FaultProposal } from "../types.js";
import type { JudgeVerdict } from "../domain/judgeSchema.js";

export type ProposeInput = {
  purchaseId: string;
  /** Lets the recorded adapter find its saved answer. Live providers never see it. */
  fixtureKey: string | null;
  amountCents: number;
  merchantName: string;
  operatorName: string;
  records: BundleRecord[];
  complaint: string;
};

/** Where an answer came from. Stored with the proposal and shown on screen. */
export type AiSource = {
  kind: "live" | "recorded";
  provider: string;
  model: string;
  /** Set when a live call failed and the recorded answer was used instead. */
  note?: string;
};

export type AiResult = { proposal: FaultProposal; source: AiSource };

export type JudgeInput = ProposeInput & { proposal: FaultProposal };
export type JudgeResult = { verdict: JudgeVerdict; source: AiSource };

export interface AiAdapter {
  readonly modeLabel: string;
  readonly kind: "live" | "recorded";
  readonly provider: string;
  readonly model: string;
  readonly fallbackToRecorded: boolean;
  proposeFault(input: ProposeInput): Promise<AiResult>;
  /** A second, independent pass with its own prompt (and its own model when one is configured). It weighs the evidence, it never sets money. */
  judgeEvidence(input: JudgeInput): Promise<JudgeResult>;
}
