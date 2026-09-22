import { exec } from "child_process";
import { promisify } from "util";
import { toolTimeoutMs, validateTerminalCommand } from "./safety";
import type { ToolResult } from "./types";

const execAsync = promisify(exec);

export async function runTerminal(command: string): Promise<ToolResult> {
  const err = validateTerminalCommand(command);
  if (err) return { ok: false, output: "", error: err };

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: toolTimeoutMs("terminal"),
      maxBuffer: 512 * 1024,
      env: { ...process.env, LANG: "en_US.UTF-8" },
    });
    const out = [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n");
    return { ok: true, output: out || "(no output)" };
  } catch (e) {
    const ex = e as { stdout?: string; stderr?: string; message?: string };
    const out = [ex.stdout?.trim(), ex.stderr?.trim()].filter(Boolean).join("\n");
    return {
      ok: false,
      output: out,
      error: ex.message || "command failed",
    };
  }
}
