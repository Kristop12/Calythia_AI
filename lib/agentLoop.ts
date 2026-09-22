import type { ChatMessage } from "@/lib/lmstudio";
import type { LlmTarget } from "@/lib/llmProvider";
import {
  formatToolResult,
  parseToolCall,
  runTool,
} from "@/lib/tools/registry";
import type { AgentMessage, OpenAiTool } from "@/lib/tools/types";

const MAX_TOOL_ROUNDS = 8;

type ChatCompletionMessage = AgentMessage;

function toAgentMessages(messages: ChatMessage[]): ChatCompletionMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

type NonStreamResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
};

async function chatCompletion(
  messages: ChatCompletionMessage[],
  tools: OpenAiTool[],
  target: LlmTarget,
  signal: AbortSignal,
  stream: boolean,
): Promise<Response> {
  const payload: Record<string, unknown> = {
    messages,
    temperature: 0.7,
    stream,
  };
  if (target.model) payload.model = target.model;
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  return fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...target.headers,
    },
    body: JSON.stringify(payload),
    signal,
  });
}

async function runToolRound(
  messages: ChatCompletionMessage[],
  tools: OpenAiTool[],
  target: LlmTarget,
  signal: AbortSignal,
): Promise<{ messages: ChatCompletionMessage[]; done: boolean; content?: string }> {
  const res = await chatCompletion(messages, tools, target, signal, false);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `LLM returned ${res.status}`);
  }

  const json = (await res.json()) as NonStreamResponse;
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error("Empty LLM response");

  const assistantMsg: ChatCompletionMessage = {
    role: "assistant",
    content: msg.content ?? null,
    tool_calls: msg.tool_calls,
  };
  const next = [...messages, assistantMsg];

  if (!msg.tool_calls?.length) {
    return { messages: next, done: true, content: msg.content ?? "" };
  }

  for (const tc of msg.tool_calls) {
    const parsed = parseToolCall(tc.id, tc.function.name, tc.function.arguments);
    let toolContent: string;
    if ("error" in parsed) {
      toolContent = `ERROR: ${parsed.error}`;
    } else {
      const result = await runTool(parsed.name, parsed.arguments);
      toolContent = formatToolResult(tc.id, result);
    }
    next.push({
      role: "tool",
      tool_call_id: tc.id,
      content: toolContent,
    });
  }

  return { messages: next, done: false };
}

/** Run tool loop until the model returns text; then stream the final reply. */
export async function streamAgentLoop(
  messages: ChatMessage[],
  tools: OpenAiTool[],
  target: LlmTarget,
  signal: AbortSignal,
): Promise<Response> {
  let agentMessages = toAgentMessages(messages);
  let rounds = 0;
  const model = target.model;

  while (rounds < MAX_TOOL_ROUNDS) {
    const round = await runToolRound(agentMessages, tools, target, signal);
    agentMessages = round.messages;
    if (round.done) {
      if (round.content?.trim()) {
        return streamFinalContent(round.content, model, target.provider);
      }
      break;
    }
    rounds++;
  }

  const streamRes = await chatCompletion(agentMessages, [], target, signal, true);
  if (!streamRes.ok || !streamRes.body) {
    const detail = await streamRes.text().catch(() => "");
    throw new Error(detail || `LLM stream failed (${streamRes.status})`);
  }

  return new Response(streamRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Calythia-Path": "native-tools",
      "X-Calythia-Provider": target.provider,
      ...(model ? { "X-Calythia-Model": model } : {}),
    },
  });
}

function streamFinalContent(
  content: string,
  model: string | null,
  provider: string,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const chunk = {
        choices: [{ delta: { content } }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Calythia-Path": "native-tools",
      "X-Calythia-Provider": provider,
      ...(model ? { "X-Calythia-Model": model } : {}),
    },
  });
}
