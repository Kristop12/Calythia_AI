import type { AgentMode } from "@/lib/agentMode";
import { normalizeAgentMode } from "@/lib/agentMode";
import { wantsExecution } from "@/lib/mcpRoute";
import { nativeToolsEnabled } from "./safety";
import { getToolSchemasForQuery } from "./registry";
import { selectNativeTools } from "./selectNativeTools";
import type { OpenAiTool } from "./types";

const CHITCHAT =
  /^(hi|hello|hey|yo|thanks|thank you|ok|okay|yes|no|bye|good (morning|afternoon|evening|night)|how are you|what('?s| is) your name|who are you)[.!?]*$/i;

export function shouldUseNativeTools(userText: string, agentMode: AgentMode): boolean {
  if (!nativeToolsEnabled()) return false;
  const mode = normalizeAgentMode(agentMode);
  if (mode === "off" || mode === "pc") return false;
  const trimmed = userText.trim();
  if (!trimmed || CHITCHAT.test(trimmed)) return false;
  if (mode === "code") return true;
  if (mode === "auto") return wantsExecution(userText);
  return false;
}

export function nativeToolsForRequest(userText: string, agentMode: AgentMode): OpenAiTool[] {
  const mode = normalizeAgentMode(agentMode);
  const forceAll = mode === "code";
  return getToolSchemasForQuery(userText, forceAll);
}

export function nativeToolNamesForRequest(userText: string, agentMode: AgentMode): string[] {
  const mode = normalizeAgentMode(agentMode);
  return selectNativeTools(userText, mode === "code").map((d: { name: string }) => d.name);
}

export const NATIVE_TOOLS_SYSTEM_HINT =
  "You have native Calythia tools. When a task needs the PC, browser, files, or YouTube: call the function first and wait for a tool result message before answering. Never claim a tool succeeded until you have the tool result. Never invent tool output. After tools finish, give a short spoken answer (1–3 sentences).";
