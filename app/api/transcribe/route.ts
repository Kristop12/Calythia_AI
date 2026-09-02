import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BASE = "http://127.0.0.1:1234/v1";

function baseUrl() {
  const raw = process.env.LM_STUDIO_BASE_URL?.trim() || DEFAULT_BASE;
  return raw.replace(/\/$/, "");
}

function lmStudioToken(): string {
  return process.env.LM_STUDIO_API_TOKEN?.trim() || "lm-studio";
}

/** Quick check — LM Studio often rejects multipart audio with 415. */
export async function GET() {
  const whisperModel = process.env.LM_STUDIO_WHISPER_MODEL?.trim();
  try {
    const probe = new FormData();
    probe.append("file", new Blob([new Uint8Array(0)], { type: "audio/webm" }), "probe.webm");
    probe.append("response_format", "json");
    if (whisperModel) probe.append("model", whisperModel);
    const res = await fetch(`${baseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${lmStudioToken()}` },
      body: probe,
    });
    const text = await res.text();
    const jsonOnly = /application\/json|Unsupported Media Type/i.test(text);
    // Only trust a successful transcription response — empty probes often return 400/415.
    const whisperSupported = res.ok && !jsonOnly;
    return NextResponse.json({
      whisperSupported,
      whisperModel: whisperModel || null,
      hint: whisperSupported
        ? "LM Studio accepts audio transcription."
        : "LM Studio does not accept audio uploads on this server. Use Chrome voice input (internet) for mic.",
    });
  } catch {
    return NextResponse.json({
      whisperSupported: false,
      whisperModel: whisperModel || null,
      hint: "Cannot reach LM Studio for transcription probe.",
    });
  }
}

/**
 * Proxy audio → OpenAI-compatible Whisper:
 * POST /v1/audio/transcriptions (multipart)
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form with file" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "Audio file required" }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const name = file instanceof File && file.name ? file.name : "speech.webm";
  const mime = file.type || "audio/webm";

  const upload = new File([bytes], name, { type: mime });
  const upstreamForm = new FormData();
  upstreamForm.append("file", upload);
  upstreamForm.append("response_format", "json");
  const whisperModel = process.env.LM_STUDIO_WHISPER_MODEL?.trim();
  if (whisperModel) upstreamForm.append("model", whisperModel);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${lmStudioToken()}` },
      body: upstreamForm,
      signal: request.signal,
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Cannot reach LM Studio for transcription. Browser voice STT will be used when available.",
      },
      { status: 502 },
    );
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    let detail = raw;
    try {
      const j = JSON.parse(raw) as { error?: string | { message?: string } };
      if (typeof j.error === "string") detail = j.error;
      else if (j.error && typeof j.error === "object" && j.error.message) detail = j.error.message;
    } catch {
      /* keep raw */
    }

    const wantsJson = /application\/json|Unsupported Media Type/i.test(detail);
    return NextResponse.json(
      {
        error: wantsJson
          ? "LM Studio does not support Whisper audio uploads on this server (JSON-only). Calythia will use browser speech recognition instead when possible."
          : detail ||
            `Transcription failed (${upstream.status}). Load a Whisper STT model, or use browser voice STT.`,
      },
      { status: upstream.status >= 400 ? upstream.status : 502 },
    );
  }

  try {
    const j = JSON.parse(raw) as { text?: string };
    return NextResponse.json({ text: j.text ?? "" });
  } catch {
    return NextResponse.json({ text: raw.trim() });
  }
}
