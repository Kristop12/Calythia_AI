import { execFile } from "child_process";
import { promisify } from "util";
import { toolTimeoutMs } from "./safety";
import type { ToolResult } from "./types";

const execFileAsync = promisify(execFile);

function ytDlpPath(): string {
  return process.env.YT_DLP_PATH?.trim() || "yt-dlp";
}

export async function youtubeInfo(url: string): Promise<ToolResult> {
  const u = url.trim();
  if (!u) return { ok: false, output: "", error: "url required" };
  try {
    const { stdout } = await execFileAsync(
      ytDlpPath(),
      ["--dump-single-json", "--skip-download", "--no-warnings", u],
      { timeout: toolTimeoutMs("default"), maxBuffer: 4 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const summary = {
      title: data.title,
      channel: data.channel,
      duration: data.duration,
      description: typeof data.description === "string"
        ? data.description.slice(0, 2000)
        : undefined,
      webpage_url: data.webpage_url,
      upload_date: data.upload_date,
    };
    return { ok: true, output: JSON.stringify(summary, null, 2) };
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function youtubeTranscript(url: string): Promise<ToolResult> {
  const u = url.trim();
  if (!u) return { ok: false, output: "", error: "url required" };
  try {
    const { stdout } = await execFileAsync(
      ytDlpPath(),
      ["--skip-download", "--write-auto-sub", "--sub-lang", "en", "--sub-format", "json3", "--print", "%(title)s", u],
      { timeout: toolTimeoutMs("default"), maxBuffer: 8 * 1024 * 1024 },
    );
    // Fallback: try to get subtitles via --print subtitles
    if (!stdout?.trim()) {
      const { stdout: subs } = await execFileAsync(
        ytDlpPath(),
        ["--skip-download", "--print", "%(subtitles)j", u],
        { timeout: toolTimeoutMs("default"), maxBuffer: 2 * 1024 * 1024 },
      );
      return { ok: true, output: subs?.trim() || "No subtitles found" };
    }
    return { ok: true, output: stdout.trim() };
  } catch {
    try {
      const { stdout } = await execFileAsync(
        ytDlpPath(),
        ["--skip-download", "--print", "%(subtitles)j", u],
        { timeout: toolTimeoutMs("default"), maxBuffer: 2 * 1024 * 1024 },
      );
      return { ok: true, output: stdout?.trim() || "No subtitles available for this video." };
    } catch (e) {
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function extractYoutubeUrl(text: string): string | null {
  const m = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s]+|youtu\.be\/[^\s]+)/i,
  );
  return m ? m[0] : null;
}
