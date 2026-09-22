/**
 * Client-safe LLM provider types + localStorage (no Node / server imports).
 */

export type LlmProvider = "lmstudio" | "grok";

const PROVIDER_KEY = "calythia-llm-provider";
const MODEL_KEY = "calythia-llm-model";

export const LLM_PROVIDER_META: Record<
  LlmProvider,
  { label: string; hint: string }
> = {
  lmstudio: {
    label: "Local",
    hint: "LM Studio on this Mac",
  },
  grok: {
    label: "Grok",
    hint: "xAI cloud API",
  },
};

/** Curated defaults when /v1/models is unavailable. */
export const GROK_CURATED_MODELS: { id: string; label: string }[] = [
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-4.3", label: "Grok 4.3" },
  { id: "grok-build-0.1", label: "Grok Build" },
];

export function normalizeProvider(v: string | undefined | null): LlmProvider {
  if (v === "grok" || v === "xai") return "grok";
  return "lmstudio";
}

export function loadLlmProvider(): LlmProvider {
  if (typeof window === "undefined") return "lmstudio";
  try {
    return normalizeProvider(localStorage.getItem(PROVIDER_KEY));
  } catch {
    return "lmstudio";
  }
}

export function saveLlmProvider(provider: LlmProvider) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PROVIDER_KEY, provider);
  } catch {
    /* ignore */
  }
}

export function loadLlmModel(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(MODEL_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function saveLlmModel(model: string) {
  if (typeof window === "undefined") return;
  try {
    if (!model) localStorage.removeItem(MODEL_KEY);
    else localStorage.setItem(MODEL_KEY, model);
  } catch {
    /* ignore */
  }
}

export function defaultGrokModelId(): string {
  return "grok-4.6";
}
