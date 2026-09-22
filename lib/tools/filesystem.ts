import { readFile, readdir } from "fs/promises";
import path from "path";
import { allowedPaths, isPathAllowed } from "./safety";
import type { ToolResult } from "./types";

export async function readFileTool(filePath: string): Promise<ToolResult> {
  const p = path.resolve(filePath.trim());
  if (!isPathAllowed(p)) {
    return { ok: false, output: "", error: `Path not allowed: ${p}` };
  }
  try {
    const content = await readFile(p, "utf8");
    const max = 32_000;
    const text = content.length > max ? content.slice(0, max) + "\n…(truncated)" : content;
    return { ok: true, output: text };
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listDirectory(dirPath: string): Promise<ToolResult> {
  const p = path.resolve(dirPath.trim() || allowedPaths()[0] || ".");
  if (!isPathAllowed(p)) {
    return { ok: false, output: "", error: `Path not allowed: ${p}` };
  }
  try {
    const entries = await readdir(p, { withFileTypes: true });
    const lines = entries.slice(0, 200).map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`);
    return { ok: true, output: lines.join("\n") || "(empty)" };
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }
}
