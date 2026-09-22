import { execFile } from "child_process";
import { homedir } from "os";
import path from "path";
import { promisify } from "util";
import { lmStudioApiToken, resolveChatModel } from "@/lib/lmstudio";
import { toolTimeoutMs } from "./safety";
import type { ToolResult } from "./types";

const execFileAsync = promisify(execFile);

function interpreterPath(): string {
  return process.env.CALYTHIA_INTERPRETER_PATH?.trim() || path.join(homedir(), ".local/bin/interpreter");
}

export async function runAgentTask(task: string): Promise<ToolResult> {
  const prompt = task.trim();
  if (!prompt) return { ok: false, output: "", error: "task required" };

  const model = await resolveChatModel();
  const args = [
    "exec",
    "--oss",
    "--local-provider",
    "lmstudio",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
  ];
  if (model) {
    args.push("-c", `model='"${model.replace(/'/g, "")}"'`);
  }
  args.push(prompt);

  const env = {
    ...process.env,
    LM_STUDIO_API_TOKEN: lmStudioApiToken(),
  };

  try {
    const { stdout, stderr } = await execFileAsync(interpreterPath(), args, {
      timeout: toolTimeoutMs("agent"),
      maxBuffer: 2 * 1024 * 1024,
      env,
    });
    const out = [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n");
    return { ok: true, output: out || "(agent finished with no output)" };
  } catch (e) {
    const ex = e as { stdout?: string; stderr?: string; message?: string };
    const out = [ex.stdout?.trim(), ex.stderr?.trim()].filter(Boolean).join("\n");
    return { ok: false, output: out, error: ex.message || "Open Interpreter failed" };
  }
}
