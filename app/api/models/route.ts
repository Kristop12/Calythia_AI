import { NextResponse } from "next/server";
import {
  GROK_CURATED_MODELS,
  defaultGrokModel,
  normalizeProvider,
  xaiBaseUrl,
  xaiConfigured,
  xaiApiKey,
} from "@/lib/llmProvider";
import {
  lmStudioAuthHeaders,
  lmStudioOpenAiBase,
  resolveChatModel,
} from "@/lib/lmstudio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ModelEntry = { id: string; label: string };

async function listGrokModels(): Promise<{
  models: ModelEntry[];
  configured: boolean;
  source: "api" | "curated";
  defaultModel: string;
}> {
  const configured = xaiConfigured();
  const curated = GROK_CURATED_MODELS.map((m) => ({ ...m }));
  const defaultModel = defaultGrokModel();

  if (!configured) {
    return { models: curated, configured: false, source: "curated", defaultModel };
  }

  try {
    const res = await fetch(`${xaiBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${xaiApiKey()}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return { models: curated, configured: true, source: "curated", defaultModel };
    }
    const json = (await res.json()) as {
      data?: Array<{ id?: string }>;
    };
    const ids = (json.data || [])
      .map((m) => m.id)
      .filter((id): id is string => !!id?.trim());
    if (!ids.length) {
      return { models: curated, configured: true, source: "curated", defaultModel };
    }
    const models = ids.map((id) => {
      const known = GROK_CURATED_MODELS.find((c) => c.id === id);
      return { id, label: known?.label || id };
    });
    return { models, configured: true, source: "api", defaultModel };
  } catch {
    return { models: curated, configured: true, source: "curated", defaultModel };
  }
}

async function listLmStudioModels(): Promise<{
  models: ModelEntry[];
  configured: boolean;
  source: "api" | "pinned";
  defaultModel: string | null;
}> {
  const pinned = process.env.LM_STUDIO_MODEL?.trim() || null;
  const resolved = await resolveChatModel().catch(() => null);
  const defaultModel = pinned || resolved;

  try {
    const res = await fetch(`${lmStudioOpenAiBase()}/models`, {
      headers: { ...lmStudioAuthHeaders() },
      cache: "no-store",
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (json.data || [])
        .map((m) => m.id)
        .filter((id): id is string => !!id?.trim());
      if (ids.length) {
        return {
          models: ids.map((id) => ({ id, label: id })),
          configured: true,
          source: "api",
          defaultModel,
        };
      }
    }
  } catch {
    /* fall through */
  }

  const models: ModelEntry[] = defaultModel
    ? [{ id: defaultModel, label: defaultModel }]
    : [];
  return {
    models,
    configured: !!defaultModel,
    source: "pinned",
    defaultModel,
  };
}

/** Debug / UI: list models for a provider. */
export async function GET(request: Request) {
  const provider = normalizeProvider(
    new URL(request.url).searchParams.get("provider"),
  );

  if (provider === "grok") {
    const result = await listGrokModels();
    return NextResponse.json({
      provider,
      ...result,
      hint: result.configured
        ? "Pick a Grok model for Calythia’s cloud brain."
        : "Add XAI_API_KEY to .env.local and restart npm run dev.",
    });
  }

  const result = await listLmStudioModels();
  return NextResponse.json({
    provider,
    ...result,
    hint: result.configured
      ? "Local LM Studio model."
      : "Load a model in LM Studio or set LM_STUDIO_MODEL.",
  });
}
