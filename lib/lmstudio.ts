import { readFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { allowedToolsForQuery } from "@/lib/mcpRoute";

export type McpIntegration =
  | string
  | {
      type: "plugin";
      id: string;
      allowed_tools?: string[];
    }
  | {
      type: "ephemeral_mcp";
      server_label: string;
      server_url: string;
      allowed_tools?: string[];
      headers?: Record<string, string>;
    };

type McpJson = {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      url?: string;
      serverUrl?: string;
      headers?: Record<string, string>;
    }
  >;
};

/** Origin without trailing slash, e.g. http://127.0.0.1:1234 */
export function lmStudioOrigin(): string {
  const raw = process.env.LM_STUDIO_BASE_URL?.trim() || "http://127.0.0.1:1234/v1";
  return raw.replace(/\/$/, "").replace(/\/v1$/i, "");
}

export function lmStudioOpenAiBase(): string {
  return `${lmStudioOrigin()}/v1`;
}

export function lmStudioApiToken(): string {
  return process.env.LM_STUDIO_API_TOKEN?.trim() || "lm-studio";
}

export function lmStudioAuthHeaders(): Record<string, string> {
  const token = lmStudioApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

type NativeModel = {
  type?: string;
  key?: string;
  loaded_instances?: { id?: string }[];
};

let cachedLoadedModel: { key: string; at: number } | null = null;
const MODEL_CACHE_MS = 300_000;

/**
 * Chat model id for LM Studio APIs.
 *
 * MCP (`/api/v1/chat`) always sends `model` — if we pick an *unloaded* library
 * entry, LM Studio will load a second model. So we only auto-pick models that
 * already have `loaded_instances`, unless LM_STUDIO_MODEL is pinned.
 */
export async function resolveChatModel(signal?: AbortSignal): Promise<string | null> {
  const pinned = process.env.LM_STUDIO_MODEL?.trim();
  if (pinned) return pinned;

  if (cachedLoadedModel && Date.now() - cachedLoadedModel.at < MODEL_CACHE_MS) {
    return cachedLoadedModel.key;
  }

  try {
    const res = await fetch(`${lmStudioOrigin()}/api/v1/models`, {
      headers: lmStudioAuthHeaders(),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: NativeModel[] };
    const models = data.models || [];
    const llms = models.filter((m) => m.type === "llm" && m.key && !/whisper/i.test(m.key));

    // Use whichever chat model is already loaded in LM Studio (first loaded wins).
    for (const m of llms) {
      if (m.loaded_instances?.length && m.key) {
        cachedLoadedModel = { key: m.key, at: Date.now() };
        return m.key;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** When true (default), use /api/v1/chat with MCP integrations. */
export function mcpEnabled(): boolean {
  const v = process.env.LM_STUDIO_MCP?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

function mcpJsonPath(): string {
  const override = process.env.LM_STUDIO_MCP_JSON?.trim();
  if (override) return override;
  return path.join(homedir(), ".lmstudio", "mcp.json");
}

/** Explicit list: LM_STUDIO_MCP_SERVERS=weather,duckduckgo-search */
function serversFromEnv(): string[] {
  const raw = process.env.LM_STUDIO_MCP_SERVERS?.trim();
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("mcp/") ? s.slice(4) : s));
}

export async function loadMcpServerLabels(): Promise<string[]> {
  const fromEnv = serversFromEnv();
  if (fromEnv.length) return fromEnv;

  try {
    const raw = await readFile(mcpJsonPath(), "utf8");
    const json = JSON.parse(raw) as McpJson;
    return Object.keys(json.mcpServers || {});
  } catch {
    return [];
  }
}

/**
 * Build LM Studio `integrations` for /api/v1/chat.
 * Prefers mcp.json plugin ids (`mcp/<label>`). Remote URL servers in mcp.json
 * can also be sent as ephemeral_mcp when LM_STUDIO_MCP_EPHEMERAL=1.
 */
export async function buildMcpIntegrations(): Promise<McpIntegration[]> {
  const labels = await loadMcpServerLabels();
  if (!labels.length) return [];

  const useEphemeral = /^(1|true|yes|on)$/i.test(
    process.env.LM_STUDIO_MCP_EPHEMERAL?.trim() || "",
  );

  if (!useEphemeral) {
    return labels.map((label) => `mcp/${label}`);
  }

  let json: McpJson = {};
  try {
    json = JSON.parse(await readFile(mcpJsonPath(), "utf8")) as McpJson;
  } catch {
    return labels.map((label) => `mcp/${label}`);
  }

  const out: McpIntegration[] = [];
  for (const label of labels) {
    const cfg = json.mcpServers?.[label];
    const url = cfg?.url || cfg?.serverUrl;
    if (url) {
      out.push({
        type: "ephemeral_mcp",
        server_label: label,
        server_url: url,
        ...(cfg?.headers ? { headers: cfg.headers } : {}),
      });
    } else {
      out.push(`mcp/${label}`);
    }
  }
  return out;
}

function integrationLabel(i: McpIntegration): string {
  if (typeof i === "string") return i.replace(/^mcp\//, "");
  if (i.type === "plugin") return i.id.replace(/^mcp\//, "");
  return i.server_label;
}

/**
 * Attach MCP only when the user message needs tools.
 * For personal-pc, pass a narrowed `allowed_tools` list from context.
 */
export function filterMcpIntegrationsForQuery(
  userText: string,
  integrations: McpIntegration[],
): McpIntegration[] {
  const q = userText.toLowerCase();
  const wantsWeather =
    /\bweather\b|\bforecast\b|\btemperature\b|\bhumidity\b|\brain(?:y|ing)?\b/.test(q);
  const wantsSearch =
    /\b(?:search|google|look\s*up|find\s+online|duckduckgo|web\s+search|latest\s+news|who\s+is|what\s+is\s+trending)\b/.test(
      q,
    );

  const pcTools = allowedToolsForQuery(userText);

  const out: McpIntegration[] = [];
  for (const i of integrations) {
    const label = integrationLabel(i).toLowerCase();

    if (/weather/.test(label) && !/personal/.test(label)) {
      if (wantsWeather) out.push(i);
      continue;
    }
    if (/duckduckgo|brave|bing/.test(label) || label === "search") {
      if (wantsSearch) out.push(i);
      continue;
    }

    if (/personal[-_]?pc/.test(label)) {
      if (!pcTools?.length) continue;
      out.push({
        type: "plugin",
        id: label.startsWith("mcp/") ? label : `mcp/${label}`,
        allowed_tools: pcTools,
      });
      continue;
    }

    // Unknown servers: only if something matched for PC-style intent
    if (pcTools?.length) out.push(i);
  }
  return out;
}

export type ChatMessage = { role: string; content: string };

/** Map OpenAI-style messages → LM Studio native /api/v1/chat fields. */
export function toNativeChatParts(messages: ChatMessage[]): {
  system_prompt?: string;
  input: string | { type: "text"; content: string }[];
} {
  const systemParts: string[] = [];
  const turns: ChatMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else if (m.content?.trim()) turns.push(m);
  }

  const last = turns[turns.length - 1];
  const prior = turns.slice(0, -1);

  let system_prompt = systemParts.filter(Boolean).join("\n\n") || undefined;
  if (prior.length) {
    const transcript = prior
      .map((m) => {
        const who = m.role === "assistant" ? "Assistant" : "User";
        return `${who}: ${m.content.trim()}`;
      })
      .join("\n");
    system_prompt = system_prompt
      ? `${system_prompt}\n\nConversation so far:\n${transcript}`
      : `Conversation so far:\n${transcript}`;
  }

  return {
    system_prompt,
    input: last?.content?.trim() || "",
  };
}

/**
 * Transform LM Studio named SSE (`event: message.delta`) into OpenAI-style
 * chat.completion.chunk SSE that ApexChat already parses.
 */
export function lmStudioSseToOpenAi(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let eventName = "";

  const openAiChunk = (content: string) =>
    encoder.encode(
      `data: ${JSON.stringify({
        choices: [{ delta: { content }, index: 0 }],
      })}\n\n`,
    );

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
              continue;
            }
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;

            let parsed: {
              type?: string;
              content?: string;
              tool?: string;
              error?: { message?: string };
            };
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            const type = parsed.type || eventName;
            if (type === "message.delta" && parsed.content) {
              controller.enqueue(openAiChunk(parsed.content));
            } else if (type === "error") {
              const msg = parsed.error?.message || "LM Studio chat error";
              controller.enqueue(openAiChunk(`\n(${msg})\n`));
            } else if (type === "chat.end") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            eventName = "";
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "stream failed";
        controller.enqueue(openAiChunk(`\n(${msg})\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
  });
}

export const MCP_SETUP_HINT =
  "Enable LM Studio → Developer → Server Settings: Require Authentication + Allow calling servers from mcp.json, then set LM_STUDIO_API_TOKEN in .env.local.";
