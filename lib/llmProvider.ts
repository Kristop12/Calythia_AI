/**
 * Server-side LLM provider resolution — LM Studio (local) or Grok (xAI cloud).
 */

import {
  lmStudioAuthHeaders,
  lmStudioOpenAiBase,
  resolveChatModel,
} from "@/lib/lmstudio";
import {
  defaultGrokModelId,
  normalizeProvider,
  type LlmProvider,
} from "@/lib/llmProviderClient";

export type { LlmProvider };
export {
  GROK_CURATED_MODELS,
  LLM_PROVIDER_META,
  loadLlmModel,
  loadLlmProvider,
  normalizeProvider,
  saveLlmModel,
  saveLlmProvider,
} from "@/lib/llmProviderClient";

export type LlmTarget = {
  provider: LlmProvider;
  baseUrl: string;
  headers: Record<string, string>;
  model: string | null;
};

export function xaiApiKey(): string {
  return process.env.XAI_API_KEY?.trim() || "";
}

export function xaiConfigured(): boolean {
  return xaiApiKey().length > 8;
}

export function xaiBaseUrl(): string {
  const raw = process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1";
  return raw.replace(/\/$/, "");
}

export function defaultGrokModel(): string {
  return process.env.XAI_MODEL?.trim() || defaultGrokModelId();
}

/**
 * Resolve OpenAI-compatible chat target for the agent loop / stream path.
 * Client-selected `model` overrides env defaults.
 */
export async function resolveLlmTarget(opts: {
  provider?: string | null;
  model?: string | null;
  signal?: AbortSignal;
}): Promise<LlmTarget> {
  const provider = normalizeProvider(opts.provider);
  const clientModel = opts.model?.trim() || "";

  if (provider === "grok") {
    const key = xaiApiKey();
    if (!key) {
      throw new Error(
        "Grok selected but XAI_API_KEY is missing. Add it to .env.local and restart npm run dev.",
      );
    }
    return {
      provider: "grok",
      baseUrl: xaiBaseUrl(),
      headers: {
        Authorization: `Bearer ${key}`,
      },
      model: clientModel || defaultGrokModel(),
    };
  }

  const lmModel = clientModel || (await resolveChatModel(opts.signal));

  return {
    provider: "lmstudio",
    baseUrl: lmStudioOpenAiBase(),
    headers: lmStudioAuthHeaders(),
    model: lmModel,
  };
}
