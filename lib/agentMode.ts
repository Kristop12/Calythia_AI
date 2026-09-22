/**
 * Agent / MCP mode — how Calythia attaches tools to LM Studio chat.
 */

export type AgentMode = "auto" | "pc" | "code" | "off";

const STORAGE_KEY = "calythia-agent-mode";

export const AGENT_MODE_META: Record<
  AgentMode,
  { label: string; hint: string }
> = {
  auto: {
    label: "Auto",
    hint: "Native tools when needed (browser, files, scripts)",
  },
  pc: {
    label: "PC",
    hint: "personal-pc MCP only (legacy fallback)",
  },
  code: {
    label: "Agent",
    hint: "Native tool loop — all Calythia tools",
  },
  off: {
    label: "Chat",
    hint: "No MCP tools — fastest replies",
  },
};

export function normalizeAgentMode(v: string | undefined | null): AgentMode {
  if (v === "pc" || v === "code" || v === "off" || v === "auto") return v;
  return "auto";
}

export function loadAgentMode(): AgentMode {
  if (typeof window === "undefined") return "auto";
  try {
    return normalizeAgentMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function saveAgentMode(mode: AgentMode) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}
