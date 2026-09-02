import { NextResponse } from "next/server";
import { appendMemoryNote, loadMemoryChunks } from "@/lib/rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List loaded memory chunks (for debugging / future UI). */
export async function GET() {
  const chunks = await loadMemoryChunks();
  return NextResponse.json({
    count: chunks.length,
    chunks: chunks.map(({ id, source, text }) => ({
      id,
      source,
      preview: text.slice(0, 160),
    })),
  });
}

/** Append a note to memory/notes.md — body: { note: string } */
export async function POST(request: Request) {
  let body: { note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const note = body.note?.trim();
  if (!note) {
    return NextResponse.json({ error: "note required" }, { status: 400 });
  }
  try {
    await appendMemoryNote(note);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to save note" },
      { status: 500 },
    );
  }
}
