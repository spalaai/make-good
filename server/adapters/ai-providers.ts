import { aiProposalJsonSchema } from "../domain/aiSchema.js";

export type ProviderId = "anthropic" | "openai" | "gemini" | "openai-compatible";

export type ProviderConfig = {
  provider: ProviderId;
  /** Label shown on screen, for example "nebius". Defaults to the provider id. */
  label: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Only for openai-compatible: how hard to ask for JSON. */
  jsonMode: "schema" | "object";
};

export type HttpRequest = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

/** Thinking tokens count toward the limit on several providers, so leave plenty of room. */
const MAX_OUTPUT_TOKENS = 16000;

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.1-sol",
  gemini: "gemini-3.8-flash",
  "openai-compatible": "nvidia/nemotron-3-super-120b-a12b",
};

/** The judge uses a different model from the proposer where one is known to exist on the same key. Others fall back to the proposer's model (a different prompt only). */
export const DEFAULT_JUDGE_MODELS: Partial<Record<ProviderId, string>> = {
  gemini: "gemini-3.1-pro-preview",
};

export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  "openai-compatible": "https://api.tokenfactory.us-central1.nebius.com/v1",
};

export type JsonSpec = { name: string; schema: unknown };
const PROPOSAL_SPEC: JsonSpec = { name: "case_proposal", schema: aiProposalJsonSchema };

export function buildRequest(cfg: ProviderConfig, system: string, user: string, spec: JsonSpec = PROPOSAL_SPEC): HttpRequest {
  const base = trimSlash(cfg.baseUrl);
  switch (cfg.provider) {
    case "anthropic":
      return {
        url: `${base}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: cfg.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { format: { type: "json_schema", schema: spec.schema } },
        },
      };
    case "openai":
      return {
        url: `${base}/v1/responses`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: {
          model: cfg.model,
          instructions: system,
          input: user,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          text: {
            format: {
              type: "json_schema",
              name: spec.name,
              strict: true,
              schema: spec.schema,
            },
          },
        },
      };
    case "gemini":
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": cfg.apiKey,
        },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: spec.schema,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        },
      };
    case "openai-compatible": {
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      if (cfg.jsonMode === "schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: spec.name, strict: true, schema: spec.schema },
        };
      } else {
        body.response_format = { type: "json_object" };
      }
      return {
        url: `${base}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body,
      };
    }
  }
}

type Json = Record<string, unknown>;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Pull the model's text out of each provider's reply shape. Throws if there is none. */
export function extractText(provider: ProviderId, data: unknown): string {
  const d = (data ?? {}) as Json;
  let text = "";
  switch (provider) {
    case "anthropic": {
      for (const block of asArray(d.content)) {
        const b = block as Json;
        if (b.type === "text" && typeof b.text === "string") text += b.text;
      }
      if (d.stop_reason === "refusal" && !text) throw new Error("The model refused to answer");
      if (d.stop_reason === "max_tokens") throw new Error("The AI reply was cut off (max_tokens)");
      break;
    }
    case "openai": {
      if (d.status === "incomplete") throw new Error("The AI reply was cut off (incomplete)");
      if (typeof d.output_text === "string") {
        text = d.output_text;
        break;
      }
      for (const item of asArray(d.output)) {
        const it = item as Json;
        if (it.type !== "message") continue;
        for (const part of asArray(it.content)) {
          const p = part as Json;
          if (p.type === "output_text" && typeof p.text === "string") text += p.text;
          if (p.type === "refusal") throw new Error("The model refused to answer");
        }
      }
      break;
    }
    case "gemini": {
      const cand = asArray(d.candidates)[0] as Json | undefined;
      if (cand?.finishReason === "MAX_TOKENS") throw new Error("The AI reply was cut off (MAX_TOKENS)");
      const content = (cand?.content ?? {}) as Json;
      for (const part of asArray(content.parts)) {
        const p = part as Json;
        if (p.thought === true) continue;
        if (typeof p.text === "string") text += p.text;
      }
      break;
    }
    case "openai-compatible": {
      const choice = asArray(d.choices)[0] as Json | undefined;
      if (choice?.finish_reason === "length") throw new Error("The AI reply was cut off (length)");
      const msg = (choice?.message ?? {}) as Json;
      if (typeof msg.content === "string") text = msg.content;
      break;
    }
  }
  if (!text.trim()) throw new Error("The AI reply had no text");
  return text;
}

/** Parse JSON from model text. Tolerates a code fence or a reasoning block around it. */
export function parseJsonLoose(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("The AI reply was not JSON");
    return JSON.parse(t.slice(start, end + 1));
  }
}
