import { MockAiAdapter } from "./ai-mock.js";
import { FallbackAiAdapter, LiveAiAdapter, type FetchLike } from "./ai-live.js";
import {
  DEFAULT_BASE_URLS,
  DEFAULT_JUDGE_MODELS,
  DEFAULT_MODELS,
  type ProviderConfig,
  type ProviderId,
} from "./ai-providers.js";
import type { AiAdapter } from "./ai.js";
import type { PaymentsAdapter } from "./payments.js";
import { createPayPalPaymentsAdapter } from "./paypal/index.js";

type Env = Record<string, string | undefined>;

const NEBIUS_BASE = "https://api.tokenfactory.us-central1.nebius.com/v1";
const NEBIUS_MODEL = "nvidia/nemotron-3-super-120b-a12b";

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

const KNOWN_PROVIDERS = ["auto", "anthropic", "openai", "gemini", "nebius", "nvidia", "openai-compatible"];

/**
 * Work out which provider to use from environment variables. Returns null for recorded answers.
 * AI_PROVIDER picks one on purpose. "auto" takes the first key found, in this order:
 * Anthropic, OpenAI, Gemini, Nebius, then a generic OpenAI compatible endpoint.
 */
export function resolveProviderConfig(env: Env): ProviderConfig | null {
  const requested = (nonEmpty(env.AI_PROVIDER) ?? (env.AI_MODE === "mock" ? "mock" : "auto")).toLowerCase();
  if (requested === "mock" || requested === "recorded") return null;
  if (!KNOWN_PROVIDERS.includes(requested)) {
    // A typo must not quietly turn into some other provider.
    throw new Error(`Unknown AI_PROVIDER "${requested}". Use one of: ${KNOWN_PROVIDERS.join(", ")}, mock.`);
  }

  const anthropic = nonEmpty(env.ANTHROPIC_API_KEY);
  const openai = nonEmpty(env.OPENAI_API_KEY);
  const gemini = nonEmpty(env.GEMINI_API_KEY) ?? nonEmpty(env.GOOGLE_API_KEY);
  const nebius = nonEmpty(env.NEBIUS_API_KEY);
  const compat = nonEmpty(env.OPENAI_COMPATIBLE_API_KEY);

  const jsonMode = env.OPENAI_COMPATIBLE_JSON_MODE === "object" ? "object" : "schema";

  const make = (p: ProviderId, key: string): ProviderConfig => {
    switch (p) {
      case "anthropic":
        return {
          provider: p,
          label: "anthropic",
          model: nonEmpty(env.ANTHROPIC_MODEL) ?? DEFAULT_MODELS.anthropic,
          apiKey: key,
          baseUrl: nonEmpty(env.ANTHROPIC_BASE_URL) ?? DEFAULT_BASE_URLS.anthropic,
          jsonMode,
        };
      case "openai":
        return {
          provider: p,
          label: "openai",
          model: nonEmpty(env.OPENAI_MODEL) ?? DEFAULT_MODELS.openai,
          apiKey: key,
          baseUrl: nonEmpty(env.OPENAI_BASE_URL) ?? DEFAULT_BASE_URLS.openai,
          jsonMode,
        };
      case "gemini":
        return {
          provider: p,
          label: "gemini",
          model: nonEmpty(env.GEMINI_MODEL) ?? DEFAULT_MODELS.gemini,
          apiKey: key,
          baseUrl: nonEmpty(env.GEMINI_BASE_URL) ?? DEFAULT_BASE_URLS.gemini,
          jsonMode,
        };
      case "openai-compatible":
        return {
          provider: p,
          label: nonEmpty(env.OPENAI_COMPATIBLE_LABEL) ?? "openai-compatible",
          model: nonEmpty(env.OPENAI_COMPATIBLE_MODEL) ?? DEFAULT_MODELS["openai-compatible"],
          apiKey: key,
          baseUrl: nonEmpty(env.OPENAI_COMPATIBLE_BASE_URL) ?? DEFAULT_BASE_URLS["openai-compatible"],
          jsonMode,
        };
    }
  };

  const makeNebius = (key: string): ProviderConfig => ({
    provider: "openai-compatible",
    label: "nebius",
    model: nonEmpty(env.NEBIUS_MODEL) ?? NEBIUS_MODEL,
    apiKey: key,
    baseUrl: nonEmpty(env.NEBIUS_BASE_URL) ?? NEBIUS_BASE,
    jsonMode,
  });

  switch (requested) {
    case "anthropic":
      return anthropic ? make("anthropic", anthropic) : null;
    case "openai":
      return openai ? make("openai", openai) : null;
    case "gemini":
      return gemini ? make("gemini", gemini) : null;
    case "nebius":
    case "nvidia":
      return nebius ? makeNebius(nebius) : null;
    case "openai-compatible":
      return compat ? make("openai-compatible", compat) : null;
    case "auto":
    default:
      if (anthropic) return make("anthropic", anthropic);
      if (openai) return make("openai", openai);
      if (gemini) return make("gemini", gemini);
      if (nebius) return makeNebius(nebius);
      if (compat) return make("openai-compatible", compat);
      return null;
  }
}

/**
 * The judge's provider and model. JUDGE_PROVIDER picks another provider (it needs its own key in the environment),
 * JUDGE_MODEL picks the model. Without them the judge uses the proposer's provider and, where known, a different model.
 */
export function resolveJudgeConfig(env: Env, proposer: ProviderConfig): ProviderConfig {
  let base = proposer;
  const jp = nonEmpty(env.JUDGE_PROVIDER);
  if (jp) {
    const other = resolveProviderConfig({ ...env, AI_PROVIDER: jp, AI_MODE: undefined });
    if (!other) throw new Error(`JUDGE_PROVIDER "${jp}" has no key in the environment.`);
    base = other;
  }
  const model = nonEmpty(env.JUDGE_MODEL) ?? (jp ? base.model : DEFAULT_JUDGE_MODELS[base.provider] ?? base.model);
  return { ...base, model };
}

export function createAiAdapter(env: Env = process.env, fetchImpl?: FetchLike): AiAdapter {
  const recorded = new MockAiAdapter();
  const cfg = resolveProviderConfig(env);
  if (!cfg) return recorded;
  const timeoutMs = Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : 30000;
  const live = new LiveAiAdapter({ config: cfg, judgeConfig: resolveJudgeConfig(env, cfg), timeoutMs, fetchImpl });
  return (env.AI_FALLBACK ?? "error").toLowerCase() === "recorded"
    ? new FallbackAiAdapter(live, recorded)
    : live;
}

export function createPaymentsAdapter(): PaymentsAdapter {
  return createPayPalPaymentsAdapter();
}
