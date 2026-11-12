import { z } from "zod";

const KINDS = ["instruction", "mandate", "listing", "cart", "tracking", "delivery", "other"] as const;

/** What the independent judge may say. No amount and no remedy on purpose: it only weighs the evidence. */
export const judgeVerdictSchema = z.object({
  quotes: z
    .array(
      z.object({
        recordId: z.string().min(1),
        quote: z.string().min(1).max(400),
        role: z.enum(["supports", "background", "does_not_support"]),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(12),
  contradictions: z
    .array(
      z.object({
        recordId: z.string().min(1),
        quote: z.string().min(1).max(400),
        why: z.string().min(1).max(500),
        addressed: z.boolean(),
      }),
    )
    .max(8),
  overall: z.enum(["holds", "weak", "fails"]),
  missing: z.array(z.object({ kind: z.enum(KINDS), title: z.string().min(1).max(140), why: z.string().min(1).max(400) })).max(6),
  reasoning: z.string().min(1).max(1200),
});

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export const judgeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["quotes", "contradictions", "overall", "missing", "reasoning"],
  properties: {
    quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recordId", "quote", "role", "reason"],
        properties: {
          recordId: { type: "string" },
          quote: { type: "string" },
          role: { type: "string", enum: ["supports", "background", "does_not_support"] },
          reason: { type: "string" },
        },
      },
    },
    contradictions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recordId", "quote", "why", "addressed"],
        properties: { recordId: { type: "string" }, quote: { type: "string" }, why: { type: "string" }, addressed: { type: "boolean" } },
      },
    },
    overall: { type: "string", enum: ["holds", "weak", "fails"] },
    missing: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "why"],
        properties: { kind: { type: "string", enum: [...KINDS] }, title: { type: "string" }, why: { type: "string" } },
      },
    },
    reasoning: { type: "string" },
  },
} as const;
