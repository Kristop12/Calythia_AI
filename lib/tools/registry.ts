import { browseWeb } from "./browserUse";
import { readFileTool, listDirectory } from "./filesystem";
import { runAgentTask } from "./openInterpreter";
import { openUrl } from "./openUrl";
import { selectNativeTools, ALL_TOOL_DEFINITIONS } from "./selectNativeTools";
import { runTerminal } from "./terminal";
import type { OpenAiTool, ToolCall, ToolDefinition, ToolResult } from "./types";
import { youtubeInfo, youtubeTranscript } from "./youtube";

function toOpenAiTool(def: ToolDefinition): OpenAiTool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

export function getToolSchemas(defs: ToolDefinition[]): OpenAiTool[] {
  return defs.map(toOpenAiTool);
}

export function getToolSchemasForQuery(userText: string, forceAll = false): OpenAiTool[] {
  return getToolSchemas(selectNativeTools(userText, forceAll));
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const known = ALL_TOOL_DEFINITIONS.some((d) => d.name === name);
  if (!known) return { ok: false, output: "", error: `Unknown tool: ${name}` };

  switch (name) {
    case "open_url":
      return openUrl(String(args.url ?? ""));
    case "run_terminal":
      return runTerminal(String(args.command ?? ""));
    case "read_file":
      return readFileTool(String(args.path ?? ""));
    case "list_directory":
      return listDirectory(String(args.path ?? ""));
    case "youtube_info":
      return youtubeInfo(String(args.url ?? ""));
    case "youtube_transcript":
      return youtubeTranscript(String(args.url ?? ""));
    case "browse_web":
      return browseWeb(String(args.task ?? ""));
    case "run_agent_task":
      return runAgentTask(String(args.task ?? ""));
    default:
      return { ok: false, output: "", error: `Tool not implemented: ${name}` };
  }
}

export function parseToolCall(
  id: string,
  name: string,
  rawArgs: string,
): ToolCall | { error: string } {
  try {
    const arguments_ = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    return { id, name, arguments: arguments_ };
  } catch {
    return { error: `Invalid JSON arguments for ${name}` };
  }
}

export function formatToolResult(callId: string, result: ToolResult): string {
  if (result.ok) return result.output;
  return `ERROR: ${result.error || "failed"}\n${result.output}`.trim();
}
