import { describe, expect, it } from "vitest";
import { createAiAdapter, resolveProviderConfig } from "../server/adapters/index.js";
import { LiveAiAdapter } from "../server/adapters/ai-live.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "../server/adapters/ai-prompt.js";
import { buildRequest } from "../server/adapters/ai-providers.js";
import { aiProposalJsonSchema } from "../server/domain/aiSchema.js";
import { FIXTURES } from "../server/fixtures.js";

const f = FIXTURES[0];
const input = { purchaseId: "p", fixtureKey: f.key, amountCents: f.amountCents, merchantName: "Shop", operatorName: "Op", records: f.records, complaint: f.complaint };

const geminiReply = (obj: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] }), { status: 200 });

describe("AI adapters", () => {
  it("defaults to recorded answers without a key", () => {
    expect(resolveProviderConfig({})).toBeNull();
    expect(createAiAdapter({ AI_PROVIDER: "mock" }).kind).toBe("recorded");
  });

  it("reads a Gemini answer and drops any amount the model adds", async () => {
    const ai = new LiveAiAdapter({
      config: { provider: "gemini", label: "gemini", model: "m", apiKey: "k", baseUrl: "https://example.test", jsonMode: "schema" },
      timeoutMs: 1000,
      fetchImpl: async () => geminiReply({ ...f.recorded, refundAmount: 99999 }),
    });
    const r = await ai.proposeFault(input);
    expect(r.proposal.fault).toBe("merchant");
    expect("refundAmount" in r.proposal).toBe(false);
    expect(r.source.kind).toBe("live");
  });

  it("rejects an answer that does not fit the shape", async () => {
    const ai = new LiveAiAdapter({
      config: { provider: "gemini", label: "gemini", model: "m", apiKey: "k", baseUrl: "https://example.test", jsonMode: "schema" },
      timeoutMs: 1000,
      shapeRetries: 0,
      fetchImpl: async () => geminiReply({ fault: "everyone", confidence: 3, summary: "", citations: [] }),
    });
    await expect(ai.proposeFault(input)).rejects.toThrow(/schema/);
  });

  it("asks for a shape with no amount in it, and the prompt says the complaint is untrusted", () => {
    expect(Object.keys(aiProposalJsonSchema.properties)).toEqual(["fault", "confidence", "summary", "citations"]);
    const req = buildRequest({ provider: "gemini", label: "g", model: "m", apiKey: "k", baseUrl: "https://example.test", jsonMode: "schema" }, SYSTEM_PROMPT, buildUserPrompt(input));
    expect(JSON.stringify(req.body)).not.toMatch(/amountCents|refund_amount/);
    expect(SYSTEM_PROMPT).toMatch(/untrusted/);
    expect(SYSTEM_PROMPT).toMatch(/Do not give a refund amount/);
    expect(buildUserPrompt(input)).toContain("[r3]");
  });

  it("does not send the fixture key or the purchase amount to a live provider", () => {
    const text = buildUserPrompt(input);
    expect(text).not.toContain(f.key);
    expect(text).not.toContain("MG-ORDER");
  });
});
