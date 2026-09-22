import { execFile } from "child_process";
import { promisify } from "util";
import type { ToolResult } from "./types";

const execFileAsync = promisify(execFile);

export async function openUrl(url: string): Promise<ToolResult> {
  const u = url.trim();
  if (!u) return { ok: false, output: "", error: "url required" };
  if (!/^https?:\/\//i.test(u) && !/^www\./i.test(u)) {
    return { ok: false, output: "", error: "url must be http(s) or www." };
  }
  const target = /^www\./i.test(u) ? `https://${u}` : u;
  try {
    await execFileAsync("open", [target], { timeout: 15_000 });
    return { ok: true, output: `Opened ${target} in the default browser.` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: "", error: msg };
  }
}
