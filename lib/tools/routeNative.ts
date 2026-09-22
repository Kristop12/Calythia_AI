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
  "You have native Calythia tools. Use them for live PC/browser/file/YouTube facts — call the appropriate function, wait for the tool result, then answer briefly for speech. Never invent tool output.";
