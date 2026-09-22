import { execFile } from "child_process";
import { homedir } from "os";
import path from "path";
import { promisify } from "util";
import { lmStudioApiToken, lmStudioOpenAiBase, resolveChatModel } from "@/lib/lmstudio";
import { toolTimeoutMs } from "./safety";
import type { ToolResult } from "./types";

const execFileAsync = promisify(execFile);

function browserUseVenv(): string {
  return process.env.BROWSER_USE_VENV?.trim() || path.join(homedir(), ".venvs/browser-use");
}

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "browser_task.py");
}

export async function browseWeb(task: string): Promise<ToolResult> {
  const t = task.trim();
  if (!t) return { ok: false, output: "", error: "task required" };

  const python = path.join(browserUseVenv(), "bin", "python");
  const model = (await resolveChatModel()) || process.env.LM_STUDIO_MODEL?.trim() || "local-model";
  const base = lmStudioOpenAiBase();

  try {
    const { stdout, stderr } = await execFileAsync(
      python,
      [scriptPath(), t, model, base],
      {
        timeout: toolTimeoutMs("browser"),
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          LM_STUDIO_API_TOKEN: lmStudioApiToken(),
          OPENAI_API_KEY: lmStudioApiToken(),
        },
      },
    );
    const out = stdout?.trim() || stderr?.trim() || "(no output)";
    return { ok: true, output: out };
  } catch (e) {
    const ex = e as { stdout?: string; stderr?: string; message?: string };
    const out = [ex.stdout?.trim(), ex.stderr?.trim()].filter(Boolean).join("\n");
    return { ok: false, output: out, error: ex.message || "Browser Use failed" };
  }
}
