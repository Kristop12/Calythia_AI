import { NextResponse } from "next/server";
import {
  appendMemoryNote,
  extractRememberPhrase,
  formatMemoryContext,
  retrieveMemoryForQuery,
} from "@/lib/rag";
import {
  MCP_SETUP_HINT,
  buildMcpIntegrations,
  filterMcpIntegrationsForQuery,
  lmStudioAuthHeaders,
  lmStudioOpenAiBase,
  lmStudioOrigin,
  lmStudioSseToOpenAi,
  mcpEnabled,
  resolveChatModel,
  toNativeChatParts,
  type ChatMessage,
} from "@/lib/lmstudio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content?.trim()) {
      return messages[i].content.trim();
    }
  }
  return "";
}

function withRag(messages: ChatMessage[], memoryBlock: string): ChatMessage[] {
  if (!memoryBlock.trim()) return messages;
  const out = messages.map((m) => ({ ...m }));
  const sysIdx = out.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    out[sysIdx] = {
      ...out[sysIdx],
      content: `${out[sysIdx].content}\n\n---\n${memoryBlock}`,
    };
  } else {
    out.unshift({ role: "system", content: memoryBlock });
  }
  return out;
}

function sseHeaders(extra?: Record<string, string>) {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...(extra || {}),
  };
}

async function streamOpenAiCompatible(
  enriched: ChatMessage[],
  signal: AbortSignal,
  model: string | null,
): Promise<Response> {
  const payload: Record<string, unknown> = {
    messages: enriched,
    stream: true,
    temperature: 0.7,
  };
  if (model) payload.model = model;

  let upstream: Response;
  try {
    upstream = await fetch(`${lmStudioOpenAiBase()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...lmStudioAuthHeaders(),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Cannot reach LM Studio. Start the local server (default http://127.0.0.1:1234) and load a model.",
      },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: detail || `LM Studio returned ${upstream.status}` },
      { status: upstream.status >= 400 ? upstream.status : 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: sseHeaders({
      "X-Calythia-Path": "openai",
      ...(model ? { "X-Calythia-Model": model } : {}),
    }),
  });
}

async function streamNativeMcp(
  enriched: ChatMessage[],
  integrations: Awaited<ReturnType<typeof buildMcpIntegrations>>,
  signal: AbortSignal,
  model: string | null,
): Promise<Response> {
  if (!model) {
    return NextResponse.json(
      {
        error:
          "No chat model loaded in LM Studio. Load one model in the UI first, or set LM_STUDIO_MODEL in .env.local to that model id (avoids loading a second model for MCP).",
        mcp: true,
      },
      { status: 400 },
    );
  }

  const { system_prompt, input } = toNativeChatParts(enriched);

  const payload: Record<string, unknown> = {
    model,
    input,
    stream: true,
    store: false,
    temperature: 0.7,
    context_length: Number(process.env.LM_STUDIO_CONTEXT_LENGTH) || 8192,
    integrations,
  };
  if (system_prompt) payload.system_prompt = system_prompt;

  let upstream: Response;
  try {
    upstream = await fetch(`${lmStudioOrigin()}/api/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...lmStudioAuthHeaders(),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return NextResponse.json(
      {
        error: `Cannot reach LM Studio MCP chat API (${msg}).`,
        mcp: true,
        integrations,
        model,
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    let detail = await upstream.text().catch(() => "");
    try {
      const j = JSON.parse(detail) as { error?: { message?: string } | string };
      if (typeof j.error === "string") detail = j.error;
      else if (j.error?.message) detail = j.error.message;
    } catch {
      /* keep raw */
    }

    const modelMissing =
      upstream.status === 404 || /model_not_found|Invalid model identifier/i.test(detail);
    if (modelMissing && /model/i.test(detail)) {
      return NextResponse.json(
        {
          error: detail || `Model not available in LM Studio (${model}).`,
          mcp: true,
          model,
          integrations,
        },
        { status: 400 },
      );
    }

    if (upstream.status === 404 || upstream.status === 405) {
      return NextResponse.json(
        {
          error:
            "LM Studio MCP chat API not found. Update LM Studio to 0.4+ and enable the Developer server.",
          mcp: true,
        },
        { status: 502 },
      );
    }

    const permission =
      upstream.status === 403 || /Permission denied|mcp\.json|plugin/i.test(detail);
    const auth = upstream.status === 401 || /api_key|token|Authorization/i.test(detail);

    return NextResponse.json(
      {
        error: auth
          ? `LM Studio rejected the API token. ${MCP_SETUP_HINT}`
          : permission
            ? `${detail || "MCP permission denied."} ${MCP_SETUP_HINT}`
            : detail || `LM Studio MCP chat failed (${upstream.status})`,
        mcp: true,
        integrations,
        model,
      },
      {
        status: auth
          ? 401
          : permission
            ? 403
            : upstream.status >= 400
              ? upstream.status
              : 502,
      },
    );
  }

  if (!upstream.body) {
    return NextResponse.json({ error: "Empty MCP response body" }, { status: 502 });
  }

  return new Response(lmStudioSseToOpenAi(upstream.body), {
    status: 200,
    headers: sseHeaders({
      "X-Calythia-Path": "mcp",
      "X-Calythia-MCP": "1",
      "X-Calythia-Model": model,
      "X-Calythia-Integrations": integrations
        .map((i) => (typeof i === "string" ? i : "id" in i ? i.id : i.server_label))
        .join(","),
    }),
  });
}

export async function POST(request: Request) {
  let body: { messages?: ChatMessage[]; mcp?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages array required" }, { status: 400 });
  }

  const userText = lastUserText(messages);

  const remember = extractRememberPhrase(userText);
  if (remember) {
    try {
      await appendMemoryNote(remember);
    } catch {
      /* non-fatal */
    }
  }

  const chunks = await retrieveMemoryForQuery(userText || "christopher calythia", 5);
  const enriched = withRag(messages, formatMemoryContext(chunks));

  const chatModel = await resolveChatModel(request.signal);

  const wantMcp = mcpEnabled() && body.mcp !== false;
  if (wantMcp) {
    const all = await buildMcpIntegrations();
    const integrations = filterMcpIntegrationsForQuery(userText, all);
    if (integrations.length) {
      return streamNativeMcp(enriched, integrations, request.signal, chatModel);
    }
  }

  return streamOpenAiCompatible(enriched, request.signal, chatModel);
}
