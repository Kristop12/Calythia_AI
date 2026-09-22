import type { ToolGroup } from "@/lib/mcpRoute";
import { selectToolGroups, wantsOpenInterpreter } from "@/lib/mcpRoute";
import { extractYoutubeUrl } from "./youtube";
import type { ToolDefinition } from "./types";

export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "open_url",
    description: "Open a URL in the default browser (macOS open). Use for YouTube, websites, links.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "http(s) or www URL" } },
      required: ["url"],
      additionalProperties: false,
    },
    groups: ["applications"],
  },
  {
    name: "run_terminal",
    description: "Run a shell command on the Mac and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command" } },
      required: ["command"],
      additionalProperties: false,
    },
    groups: ["system_shell", "processes", "system_info"],
  },
  {
    name: "read_file",
    description: "Read a text file from an allowed directory (Documents, Downloads, etc.).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute or relative file path" } },
      required: ["path"],
      additionalProperties: false,
    },
    groups: ["filesystem"],
  },
  {
    name: "list_directory",
    description: "List files and folders in an allowed directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path" } },
      required: ["path"],
      additionalProperties: false,
    },
    groups: ["filesystem"],
  },
  {
    name: "youtube_info",
    description: "Get YouTube video metadata (title, channel, duration, description) via yt-dlp. Prefer over browser for YouTube URLs.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "YouTube video URL" } },
      required: ["url"],
      additionalProperties: false,
    },
    groups: ["applications"],
  },
  {
    name: "youtube_transcript",
    description: "Get available subtitles/transcript info for a YouTube video via yt-dlp.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "YouTube video URL" } },
      required: ["url"],
      additionalProperties: false,
    },
    groups: ["applications"],
  },
  {
    name: "browse_web",
    description:
      "Use Browser Use to search the web, click links, read pages, fill forms. For Google search, complex sites—not for simple open URL.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "What to do in the browser" } },
      required: ["task"],
      additionalProperties: false,
    },
    groups: ["browser", "web"],
    browserOnly: true,
  },
  {
    name: "run_agent_task",
    description:
      "Run a multi-step coding/shell automation task via Open Interpreter (scripts, Python, debug, automate).",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "Full task description" } },
      required: ["task"],
      additionalProperties: false,
    },
    groups: [],
    codingOnly: true,
  },
];

/** Pick native tool schemas for this user message (keeps context small). */
export function selectNativeTools(userText: string, forceAll = false): ToolDefinition[] {
  if (forceAll) return [...ALL_TOOL_DEFINITIONS];

  const groups = new Set(selectToolGroups(userText));
  const ytUrl = extractYoutubeUrl(userText);
  const q = userText.toLowerCase();

  const hasYoutubeMeta =
    ytUrl ||
    /\b(summarize|summary|transcript|subtitle|duration|title of).*\b(youtube|youtu\.be|video)\b/i.test(q) ||
    /\b(youtube|youtu\.be)\b.*\b(summarize|summary|transcript|info|metadata)\b/i.test(q);

  const out: ToolDefinition[] = [];

  for (const def of ALL_TOOL_DEFINITIONS) {
    if (def.codingOnly && wantsOpenInterpreter(userText)) {
      out.push(def);
      continue;
    }
    if (def.browserOnly && (groups.has("browser") || groups.has("web"))) {
      // Skip browse_web for pure "open youtube" — use open_url
      if (def.name === "browse_web" && /\bopen\b.*\byoutube\b/i.test(q) && !/\bsearch\b/i.test(q)) {
        continue;
      }
      out.push(def);
      continue;
    }
    if (def.name === "youtube_info" || def.name === "youtube_transcript") {
      if (hasYoutubeMeta) out.push(def);
      continue;
    }
    if (def.groups.some((g) => groups.has(g as ToolGroup))) {
      out.push(def);
    }
  }

  return out;
}
