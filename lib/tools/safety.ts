import path from "path";

const DEFAULT_TIMEOUT_MS = 60_000;
const TERMINAL_TIMEOUT_MS = 30_000;

const BLOCKED_TERMINAL =
  /\b(rm\s+-rf|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|sudo\s+rm|chmod\s+777\s+\/)\b/i;

export function nativeToolsEnabled(): boolean {
  const v = process.env.CALYTHIA_NATIVE_TOOLS?.trim();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}

export function allowedPaths(): string[] {
  const raw =
    process.env.CALYTHIA_ALLOWED_PATHS?.trim() ||
    process.env.ALLOWED_PATHS?.trim() ||
    "";
  if (!raw) {
    return [
      path.join(process.env.HOME || "/Users/kristoffer", "Documents"),
      path.join(process.env.HOME || "/Users/kristoffer", "Downloads"),
    ];
  }
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

export function isPathAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const roots = allowedPaths().map((r) => path.resolve(r));
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

export function validateTerminalCommand(command: string): string | null {
  const c = command.trim();
  if (!c) return "Empty command";
  if (BLOCKED_TERMINAL.test(c)) return "Command blocked by safety policy";
  if (c.length > 4000) return "Command too long";
  return null;
}

export function toolTimeoutMs(kind: "terminal" | "default" | "agent" | "browser"): number {
  if (kind === "terminal") return TERMINAL_TIMEOUT_MS;
  if (kind === "agent") return Number(process.env.CALYTHIA_OI_TIMEOUT_MS) || 300_000;
  if (kind === "browser") return Number(process.env.CALYTHIA_BROWSER_TIMEOUT_MS) || 180_000;
  return DEFAULT_TIMEOUT_MS;
}
