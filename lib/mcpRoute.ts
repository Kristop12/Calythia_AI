/**
 * Context → MCP tool routing for personal-pc.
 * Only matching tool schemas are sent to LM Studio (faster, safer).
 */

import { normalizeAgentMode, type AgentMode } from "@/lib/agentMode";

export type ToolGroup =
  | "filesystem"
  | "applications"
  | "processes"
  | "system_time"
  | "system_location"
  | "system_info"
  | "system_shell"
  | "weather"
  | "browser"
  | "web"
  | "gmail"
  | "social"
  | "memory"
  | "security";

const TOOLS: Record<ToolGroup, string[]> = {
  filesystem: [
    "filesystem.list_directory",
    "filesystem.read_file",
    "filesystem.search",
    "filesystem.write_file",
    "filesystem.copy",
    "filesystem.move",
    "filesystem.delete",
  ],
  applications: [
    "applications.list_running",
    "applications.open",
    "applications.open_file",
    "applications.open_url",
  ],
  processes: ["processes.list", "processes.terminate"],
  system_time: ["system.datetime"],
  system_location: ["system.location"],
  system_info: ["system.info"],
  system_shell: ["system.run_command"],
  weather: ["weather.forecast"],
  browser: [
    "browser.navigate",
    "browser.get_page",
    "browser.search_web",
    "browser.screenshot",
    "browser.close",
  ],
  web: ["web.fetch", "web.request"],
  gmail: [
    "gmail.auth_status",
    "gmail.list_messages",
    "gmail.search",
    "gmail.read_message",
    "gmail.list_attachments",
    "gmail.download_attachment",
    "gmail.create_draft",
    "gmail.send",
    "gmail.reply",
    "gmail.delete",
    "gmail.modify_labels",
  ],
  social: [
    "social.list_sources",
    "social.list_notifications",
    "social.search_notifications",
  ],
  memory: [
    "memory.profile",
    "memory.list",
    "memory.search",
    "memory.get",
    "memory.save",
    "memory.delete",
  ],
  security: ["security.confirm_operation", "security.policy"],
};

/** Groups that can mutate the machine / send mail / etc. */
const WRITE_GROUPS = new Set<ToolGroup>([
  "filesystem",
  "applications",
  "processes",
  "gmail",
  "memory",
  "system_shell",
]);

function isChitchat(q: string): boolean {
  return /^(hi|hello|hey|yo|thanks|thank you|ok|okay|yes|no|bye|good (morning|afternoon|evening|night)|how are you|what('?s| is) your name|who are you)[.!?]*$/i.test(
    q.trim(),
  );
}

/** Which personal-pc tool groups the user message needs. */
export function selectToolGroups(userText: string): ToolGroup[] {
  const q = userText.toLowerCase().trim();
  if (!q || isChitchat(q)) return [];

  const groups = new Set<ToolGroup>();

  if (/\bweather\b|\bforecast\b|\btemperature\b|\bhumidity\b|\brain(?:y|ing)?\b/.test(q)) {
    groups.add("weather");
    groups.add("system_location");
  }

  if (
    /\b(email|gmail|inbox|draft|attachment|reply to (an? )?email|send (an? )?email)\b/.test(q)
  ) {
    groups.add("gmail");
  }

  if (
    /\b(file|files|folder|directory|document|documents|download|downloads|desktop|path|disk)\b/.test(
      q,
    ) ||
    /\b(list|read|write|delete|copy|move|rename|save)\b.*\b(file|folder|directory|document)\b/.test(
      q,
    ) ||
    /\b(file|folder|directory|document)s?\b.*\b(list|read|write|delete|copy|move|open)\b/.test(q)
  ) {
    groups.add("filesystem");
  }

  if (
    /\b(open (the )?(app|application|finder|chrome|safari|notes|preview))\b/.test(q) ||
    /\b(running apps|list apps|applications?)\b/.test(q) ||
    /\bopen\b.+\.(pdf|png|jpg|jpeg|txt|md|doc|docx)\b/.test(q) ||
    // Open links in the default browser via applications.open_url
    /\byoutube\b/.test(q) ||
    /\bopen (a )?(url|link|website|site|webpage)\b/.test(q)
  ) {
    groups.add("applications");
  }

  if (/\b(process|processes|kill|terminate|task manager)\b/.test(q)) {
    groups.add("processes");
  }

  if (/\b(what time|date today|today'?s date|current time|what day|timezone)\b/.test(q)) {
    groups.add("system_time");
  }

  if (/\b(where am i|my location|my city|current (city|location))\b/.test(q)) {
    groups.add("system_location");
  }

  if (/\b(system info|cpu|memory usage|ram|disk space)\b/.test(q)) {
    groups.add("system_info");
  }

  if (/\b(run (a )?command|terminal|shell|bash)\b/.test(q)) {
    groups.add("system_shell");
  }

  if (
    /\b(search( the)? web|google|look up online|browse|browser|screenshot|navigate to|open (https?:\/\/|www\.))\b/.test(
      q,
    ) ||
    /\b(who is|who'?s|current (mayor|president|score|price|news)|latest news)\b/.test(q)
  ) {
    groups.add("browser");
    groups.add("web");
  }

  if (/\b(fetch url|http request|api call|web\.fetch)\b/.test(q)) {
    groups.add("web");
  }

  if (
    /\b(facebook|instagram|twitter|\bx\b|linkedin|tiktok|reddit|discord|slack|whatsapp|social (media )?notif)/.test(
      q,
    )
  ) {
    groups.add("social");
  }

  if (
    /\b(remember|forget|preference|my profile|what do you know about me|memory\.(save|search))\b/.test(
      q,
    )
  ) {
    groups.add("memory");
  }

  // Generic “on my PC / computer / Mac” without a clearer bucket → files + clock
  if (
    groups.size === 0 &&
    /\b(my (pc|computer|mac)|on my (pc|computer|mac)|personal[-_]?pc)\b/.test(q)
  ) {
    groups.add("filesystem");
    groups.add("system_info");
  }

  if (groups.size === 0) return [];

  for (const g of [...groups]) {
    if (WRITE_GROUPS.has(g)) {
      groups.add("security");
      break;
    }
  }

  return [...groups];
}

/** Flat allowed_tools list for LM Studio integrations. */
export function allowedToolsForQuery(userText: string): string[] | null {
  const groups = selectToolGroups(userText);
  if (!groups.length) return null;

  const tools = new Set<string>();
  for (const g of groups) {
    for (const t of TOOLS[g]) tools.add(t);
  }
  return [...tools];
}

/** Fast discrete actions personal-pc handles reliably (open URL, browser, list files). */
export function wantsDiscretePcAction(userText: string): boolean {
  const tools = allowedToolsForQuery(userText);
  if (!tools?.length) return false;
  if (wantsOpenInterpreter(userText)) return false;
  return true;
}

/** Any task that needs live execution on the Mac (browser, files, scripts, automation). */
export function wantsExecution(userText: string): boolean {
  const q = userText.toLowerCase().trim();
  if (!q || isChitchat(q)) return false;
  return selectToolGroups(userText).length > 0 || wantsOpenInterpreter(userText);
}

/** Coding / automation phrasing (subset of wantsExecution). */
export function wantsOpenInterpreter(userText: string): boolean {
  const q = userText.toLowerCase().trim();
  if (!q || isChitchat(q)) return false;
  return /\b(write (a )?(python|script|code)|run (this )?(python|script|code)|automate|pip install|debug (this|the|my)|refactor|jupyter|notebook|matplotlib|pandas|numpy|analyze (the )?data|parse (this )?(csv|json|xml|log)|scrape|crawl|plot (this|the|a)|convert .+ to)\b/i.test(
    q,
  );
}

/** All personal-pc tool names (for forced PC mode). */
export function allPersonalPcTools(): string[] {
  const tools = new Set<string>();
  for (const g of Object.keys(TOOLS) as ToolGroup[]) {
    for (const t of TOOLS[g]) tools.add(t);
  }
  return [...tools];
}

export function describeToolRouting(
  userText: string,
  agentMode: AgentMode = "auto",
): {
  groups: ToolGroup[];
  tools: string[];
  openInterpreter: boolean;
  agentMode: AgentMode;
} {
  const mode = normalizeAgentMode(agentMode);
  const groups = selectToolGroups(userText);
  let tools = allowedToolsForQuery(userText) ?? [];
  const trimmed = userText.trim();
  const chitchat = isChitchat(trimmed.toLowerCase());

  let openInterpreter = false;
  if (mode === "off" || chitchat) {
    tools = [];
  } else if (mode === "code" || mode === "auto") {
    openInterpreter = wantsExecution(userText);
    tools = [];
  } else if (mode === "pc") {
    tools = tools.length ? tools : allPersonalPcTools();
  } else {
    openInterpreter = wantsExecution(userText);
  }

  return { groups, tools, openInterpreter, agentMode: mode };
}
