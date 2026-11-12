import { aiProposalSchema } from "../domain/aiSchema.js";
import { judgeJsonSchema, judgeVerdictSchema } from "../domain/judgeSchema.js";
import type { AiAdapter, AiResult, JudgeInput, JudgeResult, ProposeInput } from "./ai.js";
import { buildJudgePrompt, buildUserPrompt, JUDGE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./ai-prompt.js";
import {
  buildRequest,
  extractText,
  parseJsonLoose,
  type JsonSpec,
  type ProviderConfig,
} from "./ai-providers.js";
import type { ZodType } from "zod";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LiveAiOptions = {
  config: ProviderConfig;
  /** The judge's own provider and model. Defaults to the same configuration as the proposer. */
  judgeConfig?: ProviderConfig;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  /** Extra tries when the reply is not valid JSON or fails the schema. Default 1. */
  shapeRetries?: number;
  /** Extra tries when the provider says it is busy (429, 500, 502, 503, 504). Default 3. */
  transientRetries?: number;
  /** Wait before the first busy retry, doubled each time. Default 2000 ms. */
  retryDelayMs?: number;
};

const BUSY_STATUSES = new Set([429, 500, 502, 503, 504]);

function scrub(text: string, secret: string): string {
  let out = text.slice(0, 300);
  if (secret) out = out.split(secret).join("[key removed]");
  return out;
}

export class LiveAiAdapter implements AiAdapter {
  readonly kind = "live" as const;
  readonly provider: string;
  readonly model: string;
  readonly modeLabel: string;
  readonly fallbackToRecorded = false;
  private readonly cfg: ProviderConfig;
  readonly judgeCfg: ProviderConfig;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly shapeRetries: number;
  private readonly transientRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: LiveAiOptions) {
    this.cfg = opts.config;
    this.judgeCfg = opts.judgeConfig ?? opts.config;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.shapeRetries = opts.shapeRetries ?? 1;
    this.transientRetries = opts.transientRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.provider = opts.config.label;
    this.model = opts.config.model;
    const sameJudge = this.judgeCfg.model === this.model && this.judgeCfg.label === this.provider;
    this.modeLabel = `AI: live (${this.provider}, ${this.model})` + (sameJudge ? "" : `, judge ${this.judgeCfg.label} ${this.judgeCfg.model}`);
  }

  private async post(cfg: ProviderConfig, system: string, user: string, spec?: JsonSpec): Promise<unknown> {
    const req = buildRequest(cfg, system, user, spec);
    const controller = new AbortController();
    // The timer covers the whole exchange, body included, so a stalled body cannot hang a build.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`AI API error (${res.status}): ${scrub(body, cfg.apiKey)}`) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      if ((e as Error & { status?: number })?.status) throw e;
      if ((e as Error)?.name === "AbortError") {
        throw new Error(`AI request timed out after ${this.timeoutMs} ms`);
      }
      throw new Error(`AI request failed: ${scrub(String((e as Error)?.message ?? e), cfg.apiKey)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Building a proposal changes nothing outside the app's own database, so a busy provider is safe to retry. */
  private async postWithBusyRetry(cfg: ProviderConfig, system: string, user: string, spec?: JsonSpec): Promise<unknown> {
    for (let i = 0; ; i++) {
      try {
        return await this.post(cfg, system, user, spec);
      } catch (e) {
        const status = (e as Error & { status?: number })?.status;
        if (!status || !BUSY_STATUSES.has(status) || i >= this.transientRetries) throw e;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** i));
      }
    }
  }

  /** Ask for JSON in the given shape. Retries a busy provider and a reply that is not valid JSON or fails the schema. */
  private async askJson<T>(startCfg: ProviderConfig, system: string, user: string, spec: JsonSpec | undefined, schema: ZodType<T>, what: string): Promise<T> {
    let cfg = startCfg;
    let lastError: Error = new Error(`${what} call failed`);
    let switchedToJsonObject = false;
    for (let attempt = 0; attempt <= this.shapeRetries; attempt++) {
      let data: unknown;
      try {
        data = await this.postWithBusyRetry(cfg, system, user, spec);
      } catch (e) {
        const err = e as Error & { status?: number };
        // Some compatible servers reject json_schema. Ask for plain JSON instead, once.
        if (
          cfg.provider === "openai-compatible" &&
          cfg.jsonMode === "schema" &&
          err.status === 400 &&
          !switchedToJsonObject
        ) {
          cfg = { ...cfg, jsonMode: "object" };
          switchedToJsonObject = true;
          lastError = err;
          attempt -= 1; // switching the JSON mode is not a shape retry
          continue;
        }
        throw err;
      }
      try {
        const text = extractText(cfg.provider, data);
        const parsed = schema.safeParse(parseJsonLoose(text));
        if (!parsed.success) {
          throw new Error(`${what} output failed the schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        }
        return parsed.data;
      } catch (e) {
        lastError = e as Error;
      }
    }
    throw lastError;
  }

  async proposeFault(input: ProposeInput): Promise<AiResult> {
    const proposal = await this.askJson(this.cfg, SYSTEM_PROMPT, buildUserPrompt(input), undefined, aiProposalSchema, "AI");
    return { proposal, source: { kind: "live", provider: this.provider, model: this.model } };
  }

  async judgeEvidence(input: JudgeInput): Promise<JudgeResult> {
    const verdict = await this.askJson(this.judgeCfg, JUDGE_SYSTEM_PROMPT, buildJudgePrompt(input), { name: "evidence_review", schema: judgeJsonSchema }, judgeVerdictSchema, "Judge");
    return { verdict, source: { kind: "live", provider: this.judgeCfg.label, model: this.judgeCfg.model } };
  }
}

/** Live first. If it fails, use the recorded answer and say so. */
export class FallbackAiAdapter implements AiAdapter {
  readonly kind: "live" | "recorded";
  readonly provider: string;
  readonly model: string;
  readonly modeLabel: string;
  readonly fallbackToRecorded = true;

  constructor(
    private readonly live: AiAdapter,
    private readonly recorded: AiAdapter,
  ) {
    this.kind = live.kind;
    this.provider = live.provider;
    this.model = live.model;
    this.modeLabel = `${live.modeLabel}, recorded if it fails`;
  }

  async judgeEvidence(input: JudgeInput): Promise<JudgeResult> {
    try {
      return await this.live.judgeEvidence(input);
    } catch (e) {
      console.error(`[make-good] live judge failed, using the recorded verdict: ${String((e as Error).message).slice(0, 300)}`);
      const result = await this.recorded.judgeEvidence(input);
      return { verdict: result.verdict, source: { ...result.source, note: "The live judge did not answer, so this is a saved verdict instead." } };
    }
  }

  async proposeFault(input: ProposeInput): Promise<AiResult> {
    try {
      return await this.live.proposeFault(input);
    } catch (e) {
      console.error(`[make-good] live AI failed, using the recorded answer: ${String((e as Error).message).slice(0, 300)}`);
      const result = await this.recorded.proposeFault(input);
      return {
        proposal: result.proposal,
        source: {
          ...result.source,
          note: "The live AI did not answer, so this is a saved answer instead. Try again in a minute.",
        },
      };
    }
  }
}
