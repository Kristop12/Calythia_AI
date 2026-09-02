import { readdir, readFile, appendFile, mkdir } from "fs/promises";
import path from "path";

export const MEMORY_DIR = "memory";

export type MemoryChunk = {
  id: string;
  source: string;
  text: string;
};

const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "must", "shall", "can", "need", "dare",
  "ought", "used", "it", "its", "this", "that", "these", "those", "i", "you", "he", "she",
  "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "our", "their",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how", "with", "from",
  "as", "by", "about", "into", "over", "after", "before", "between", "under", "again",
  "further", "then", "once", "here", "there", "all", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than",
  "too", "very", "just", "also", "than", "if", "because",
]);

function memoryRoot() {
  return path.join(process.cwd(), MEMORY_DIR);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Split markdown into retrieval chunks (paragraphs / bullet groups). */
export function chunkMarkdown(source: string, content: string): MemoryChunk[] {
  const parts = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^#+\s*$/.test(p));

  const chunks: MemoryChunk[] = [];
  parts.forEach((text, i) => {
    // Skip near-empty note placeholders
    if (/^[-*]\s*$/.test(text) || text === "-") return;
    chunks.push({
      id: `${source}#${i}`,
      source,
      text,
    });
  });
  return chunks;
}

export async function loadMemoryChunks(): Promise<MemoryChunk[]> {
  const root = memoryRoot();
  let files: string[];
  try {
    files = (await readdir(root)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const all: MemoryChunk[] = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(root, file), "utf8");
      all.push(...chunkMarkdown(file, content));
    } catch {
      /* skip unreadable */
    }
  }
  return all;
}

/**
 * Lightweight lexical retrieval (BM25-ish). No extra embedding model required —
 * works with only Bionic loaded in LM Studio.
 */
export function retrieveChunks(
  query: string,
  chunks: MemoryChunk[],
  topK = 5,
): MemoryChunk[] {
  const qTokens = tokenize(query);
  if (!qTokens.length || !chunks.length) {
    // Still return a bit of core identity context when query is vague
    return chunks.filter((c) => /christopher|calythia/i.test(c.source)).slice(0, 3);
  }

  const df = new Map<string, number>();
  const docs = chunks.map((c) => {
    const tokens = tokenize(c.text + " " + c.source);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
    return { chunk: c, tf, len: tokens.length || 1 };
  });

  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N;
  const k1 = 1.2;
  const b = 0.75;

  const scored = docs.map(({ chunk, tf, len }) => {
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgLen))));
    }
    // Soft boost for identity files
    if (/christopher|calythia/i.test(chunk.source)) score *= 1.15;
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.chunk);
}

export async function retrieveMemoryForQuery(query: string, topK = 5): Promise<MemoryChunk[]> {
  const chunks = await loadMemoryChunks();
  return retrieveChunks(query, chunks, topK);
}

export function formatMemoryContext(chunks: MemoryChunk[]): string {
  if (!chunks.length) return "";
  const body = chunks
    .map((c) => `[${c.source}]\n${c.text}`)
    .join("\n\n");
  return (
    "Relevant memory from Christopher's project notes (use when helpful; do not invent facts beyond this):\n\n" +
    body
  );
}

/** Append a durable note to memory/notes.md */
export async function appendMemoryNote(note: string): Promise<void> {
  const text = note.replace(/\n+/g, " ").trim();
  if (!text) return;
  const root = memoryRoot();
  await mkdir(root, { recursive: true });
  const file = path.join(root, "notes.md");
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `\n- [${stamp}] ${text}\n`;
  try {
    await appendFile(file, line, "utf8");
  } catch {
    const seed =
      "# Notes\n\nDurable facts Calythia should recall.\n" + line;
    const { writeFile } = await import("fs/promises");
    await writeFile(file, seed, "utf8");
  }
}

/** Pull "remember …" / "remember that …" from user text. */
export function extractRememberPhrase(userText: string): string | null {
  const m = userText.match(
    /^\s*(?:please\s+)?remember(?:\s+that)?\s*[:\-]?\s+(.+)\s*$/i,
  );
  if (!m?.[1]) return null;
  const fact = m[1].trim().replace(/[.!?]+$/, "");
  return fact.length >= 3 ? fact : null;
}
