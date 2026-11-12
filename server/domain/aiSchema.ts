import { z } from "zod";

export const aiProposalSchema = z.object({
  fault: z.enum(["merchant", "operator", "customer", "unclear"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(600),
  citations: z
    .array(z.object({ recordId: z.string().min(1), quote: z.string().min(1).max(400) }))
    .max(8),
});

export type AiProposal = z.infer<typeof aiProposalSchema>;

/** The same shape for providers that take a JSON schema. No amount, by design. */
export const aiProposalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fault", "confidence", "summary", "citations"],
  properties: {
    fault: { type: "string", enum: ["merchant", "operator", "customer", "unclear"] },
    confidence: { type: "number" },
    summary: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recordId", "quote"],
        properties: { recordId: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
} as const;
