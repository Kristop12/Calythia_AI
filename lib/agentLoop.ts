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

type ToolCallRaw = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type NonStreamResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string | Record<string, unknown> };
      }>;
    };
  }>;
};

function toAgentMessages(messages: ChatMessage[]): ChatCompletionMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/** Normalize provider quirks (object args, missing ids). */
function normalizeToolCalls(
  raw:
    | Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string | Record<string, unknown> };
      }>
    | undefined
    | null,
): ToolCallRaw[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .map((tc, i) => {
      const name = tc?.function?.name?.trim();
      if (!name) return null;
      const args = tc.function?.arguments;
      const argStr =
        typeof args === "string" ? args : JSON.stringify(args ?? {});
      return {
        id: tc.id?.trim() || `call_${i}_${name}`,
        type: "function" as const,
        function: { name, arguments: argStr || "{}" },
      };
    })
    .filter((tc): tc is ToolCallRaw => !!tc);
}

/**
 * Fallback when the model writes tool calls into content instead of tool_calls
 * (common with some LM Studio / local models).
 */
function extractToolCallsFromContent(content: string): ToolCallRaw[] {
  const text = content.trim();
  if (!text) return [];
  const found: ToolCallRaw[] = [];

  // <tool_call>{"name":"...","arguments":{...}}</tool_call>
  const jsonBlock =
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonBlock.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]!) as {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
      if (!obj.name) continue;
      const argStr =
        typeof obj.arguments === "string"
          ? obj.arguments
          : JSON.stringify(obj.arguments ?? {});
      found.push({
        id: `text_${found.length}_${obj.name}`,
        type: "function",
        function: { name: obj.name, arguments: argStr },
      });
    } catch {
      /* ignore */
    }
  }

  // Qwen / Hermes: <tool_call>\ncall tool_name with ... or invoke name
  // <function=name>\n<parameter=key>value</parameter>
  const fnTag =
    /<function=([a-zA-Z0-9_]+)>([\s\S]*?)(?:<\/function>|$)/gi;
  while ((m = fnTag.exec(text)) !== null) {
    const name = m[1]!;
    const body = m[2] || "";
    const args: Record<string, string> = {};
    const paramRe =
      /<parameter=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body)) !== null) {
      args[p[1]!] = p[2]!.trim();
    }
    found.push({
      id: `text_${found.length}_${name}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }

  // Bare JSON tool call line
  if (!found.length) {
    try {
      const obj = JSON.parse(text) as {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
      if (obj.name) {
        const argStr =
          typeof obj.arguments === "string"
            ? obj.arguments
            : JSON.stringify(obj.arguments ?? {});
        found.push({
          id: `text_0_${obj.name}`,
          type: "function",
          function: { name: obj.name, arguments: argStr },
        });
      }
    } catch {
      /* ignore */
    }
  }

  return found;
}

function looksLikeToolCallText(content: string): boolean {
  return (
    /<tool_call>/i.test(content) ||
    /<function=/i.test(content) ||
    /"name"\s*:\s*"[a-zA-Z0-9_]+"\s*,\s*"arguments"/i.test(content)
  );
}

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
  onTool?: (name: string, phase: "start" | "done") => void,
): Promise<{ messages: ChatCompletionMessage[]; done: boolean; content?: string }> {
  const res = await chatCompletion(messages, tools, target, signal, false);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `LLM returned ${res.status}`);
  }

  const json = (await res.json()) as NonStreamResponse;
  const choice = json.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new Error("Empty LLM response");

  let toolCalls = normalizeToolCalls(msg.tool_calls);
  const rawContent = msg.content ?? "";

  // Local models often dump tool XML into content instead of tool_calls.
  if (!toolCalls.length && looksLikeToolCallText(rawContent)) {
    toolCalls = extractToolCallsFromContent(rawContent);
  }

  const assistantMsg: ChatCompletionMessage = {
    role: "assistant",
    content: toolCalls.length ? (rawContent.trim() || null) : rawContent,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  const next = [...messages, assistantMsg];

  if (!toolCalls.length) {
    // Do not end the turn on pseudo tool-call text we failed to parse.
    if (looksLikeToolCallText(rawContent)) {
      throw new Error(
        "Model returned a tool call in text form that could not be parsed. Try a tool-calling model (e.g. Qwen3-Coder) or Grok.",
      );
    }
    return { messages: next, done: true, content: rawContent };
  }

  for (const tc of toolCalls) {
    onTool?.(tc.function.name, "start");
    const parsed = parseToolCall(tc.id, tc.function.name, tc.function.arguments);
    let toolContent: string;
    if ("error" in parsed) {
      toolContent = `ERROR: ${parsed.error}`;
    } else {
      const result = await runTool(parsed.name, parsed.arguments);
      toolContent = formatToolResult(tc.id, result);
    }
    onTool?.(tc.function.name, "done");
    next.push({
      role: "tool",
      tool_call_id: tc.id,
      name: tc.function.name,
      content: toolContent,
    });
  }

  return { messages: next, done: false };
}

function sseHeaders(provider: string, model: string | null): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Calythia-Path": "native-tools",
    "X-Calythia-Provider": provider,
    ...(model ? { "X-Calythia-Model": model } : {}),
  };
}

/**
 * Run the tool loop and stream progress immediately so the client stays open
 * until tool results are back and the model has produced a final answer.
 */
export async function streamAgentLoop(
  messages: ChatMessage[],
  tools: OpenAiTool[],
  target: LlmTarget,
  signal: AbortSignal,
): Promise<Response> {
  const model = target.model;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
        );
      };
      const sendDone = () => {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };
      const sendContent = (content: string) => {
        if (!content) return;
        send({ choices: [{ delta: { content } }] });
      };
      const sendMeta = (meta: Record<string, unknown>) => {
        send({ calythia: meta });
      };

      // Immediate first byte — keeps the HTTP turn alive while tools run.
      sendMeta({ type: "status", status: "thinking" });
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* closed */
        }
      }, 12000);

      let agentMessages = toAgentMessages(messages);
      let rounds = 0;

      try {
        while (rounds < MAX_TOOL_ROUNDS) {
          if (signal.aborted) throw new Error("Aborted");

          const round = await runToolRound(
            agentMessages,
            tools,
            target,
            signal,
            (name, phase) => {
              sendMeta({
                type: phase === "start" ? "tool_start" : "tool_done",
                tool: name,
              });
            },
          );
          agentMessages = round.messages;

          if (round.done) {
            const content = round.content?.trim() || "";
            if (content) {
              sendContent(content);
              sendDone();
              return;
            }
            break;
          }
          rounds++;
          sendMeta({ type: "status", status: "tool_round", round: rounds });
        }

        // Final pass without tools — model must answer from tool results.
        sendMeta({ type: "status", status: "answering" });
        const streamRes = await chatCompletion(
          agentMessages,
          [],
          target,
          signal,
          true,
        );
        if (!streamRes.ok || !streamRes.body) {
          const detail = await streamRes.text().catch(() => "");
          throw new Error(detail || `LLM stream failed (${streamRes.status})`);
        }

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            if (data === "[DONE]") {
              sendDone();
              return;
            }
            try {
              const json = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const token = json.choices?.[0]?.delta?.content;
              if (token) sendContent(token);
            } catch {
              /* ignore partial */
            }
          }
        }
        sendDone();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Agent loop failed";
        send({ error: msg });
        sendContent(`Sorry — ${msg}`);
        sendDone();
      } finally {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(target.provider, model),
  });
}
