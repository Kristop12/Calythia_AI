/**
 * Voice input for Calythia.
 *
 * Primary: browser SpeechRecognition (no Whisper required).
 * Fallback: MediaRecorder → /api/transcribe (LM Studio Whisper), if browser STT fails.
 */

export type ListenController = {
  start: (opts?: { silenceMs?: number; maxMs?: number }) => void;
  stop: () => void;
  cancel: () => void;
  supported: boolean;
};

type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: Event & { error?: string }) => void) | null;
  onresult: ((ev: Event & {
    resultIndex: number;
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getRecognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function pickMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

let whisperTranscribeDisabled = false;

/** LM Studio often returns 415 for audio — remember and skip Whisper fallback. */
export function isWhisperTranscribeDisabled(): boolean {
  return whisperTranscribeDisabled;
}

export function setWhisperTranscribeDisabled(disabled: boolean) {
  whisperTranscribeDisabled = disabled;
}

export function speechRecognitionSupported(): boolean {
  return (
    !!getRecognitionCtor() ||
    (typeof window !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined")
  );
}

function rmsLevel(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

export function createListener(opts: {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  onTranscribing?: (busy: boolean) => void;
}): ListenController {
  const Rec = getRecognitionCtor();
  const canRecord =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  if (!Rec && !canRecord) {
    return {
      supported: false,
      start() {
        opts.onError?.("Speech input is not supported in this browser.");
      },
      stop() {},
      cancel() {},
    };
  }

  let rec: RecognitionLike | null = null;
  let intentionalStop = false;
  let finalized = false;

  // Whisper fallback recorder state
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];
  let shouldTranscribe = false;
  let audioCtx: AudioContext | null = null;
  let raf = 0;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let usingWhisper = false;

  const clearWhisperTimers = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (maxTimer) clearTimeout(maxTimer);
    maxTimer = null;
  };

  const cleanupWhisper = () => {
    clearWhisperTimers();
    try {
      audioCtx?.close();
    } catch {
      /* ignore */
    }
    audioCtx = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
    chunks = [];
    usingWhisper = false;
  };

  const runWhisperTranscribe = async (blob: Blob) => {
    opts.onTranscribing?.(true);
    opts.onInterim?.("Transcribing…");
    try {
      const fd = new FormData();
      const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
      fd.append("file", blob, `speech.${ext}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) {
        if (
          res.status === 415 ||
          /application\/json|Unsupported Media Type/i.test(data.error || "")
        ) {
          whisperTranscribeDisabled = true;
        }
        throw new Error(data.error || `Transcription failed (${res.status})`);
      }
      const text = (data.text || "").trim();
      if (!text) {
        opts.onError?.("No speech detected. Try again.");
        opts.onEnd?.();
        return;
      }
      opts.onFinal?.(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transcription failed";
      if (/application\/json|Unsupported Media Type/i.test(msg)) {
        opts.onError?.(
          "LM Studio rejected audio upload (needs JSON-only API). Use Chrome voice STT, or run a Whisper server that supports /v1/audio/transcriptions.",
        );
      } else {
        opts.onError?.(msg);
      }
      opts.onEnd?.();
    } finally {
      opts.onTranscribing?.(false);
    }
  };

  const startWhisperFallback = (startOpts?: { silenceMs?: number; maxMs?: number }) => {
    if (whisperTranscribeDisabled) {
      opts.onError?.(
        "Local Whisper is not available (LM Studio does not accept audio uploads). Use Chrome voice input with internet, or load Whisper in a server that supports /v1/audio/transcriptions.",
      );
      opts.onEnd?.();
      return;
    }
    if (!canRecord) {
      opts.onError?.("Microphone recording is not available for Whisper fallback.");
      return;
    }
    usingWhisper = true;
    shouldTranscribe = false;
    const silenceMs = startOpts?.silenceMs ?? 1300;
    const maxMs = startOpts?.maxMs ?? 28000;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const mime = pickMime();
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        chunks = [];
        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) chunks.push(ev.data);
        };
        recorder.onerror = () => {
          opts.onError?.("Recording failed");
          cleanupWhisper();
          opts.onEnd?.();
        };
        recorder.onstop = () => {
          const type = recorder?.mimeType || "audio/webm";
          const blob = new Blob(chunks, { type });
          const doTx = shouldTranscribe;
          cleanupWhisper();
          if (doTx && blob.size > 800) void runWhisperTranscribe(blob);
          else {
            if (doTx) opts.onError?.("No speech detected. Try again.");
            opts.onEnd?.();
          }
        };
        recorder.start(200);

        try {
          audioCtx = new AudioContext();
          if (audioCtx.state === "suspended") await audioCtx.resume();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          const buf = new Uint8Array(analyser.fftSize) as Uint8Array<ArrayBuffer>;
          const SPEECH_THRESHOLD = 0.028;
          let spoke = false;
          let speechStartedAt = 0;
          let silentSince = 0;
          const tick = (now: number) => {
            if (!recorder || recorder.state !== "recording") return;
            const level = rmsLevel(analyser, buf);
            if (level >= SPEECH_THRESHOLD) {
              if (!spoke) {
                spoke = true;
                speechStartedAt = now;
                opts.onInterim?.("Listening…");
              }
              silentSince = 0;
            } else if (spoke) {
              if (!silentSince) silentSince = now;
              if (now - speechStartedAt >= 350 && now - silentSince >= silenceMs) {
                shouldTranscribe = true;
                clearWhisperTimers();
                try {
                  recorder.requestData?.();
                  recorder.stop();
                } catch {
                  cleanupWhisper();
                  opts.onEnd?.();
                }
                return;
              }
            }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        } catch {
          /* silence watch optional */
        }

        maxTimer = setTimeout(() => {
          shouldTranscribe = true;
          try {
            recorder?.requestData?.();
            recorder?.stop();
          } catch {
            cleanupWhisper();
            opts.onEnd?.();
          }
        }, maxMs);

        opts.onStart?.();
        opts.onInterim?.("Listening… (local Whisper)");
      } catch (e) {
        cleanupWhisper();
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          opts.onError?.("Microphone permission denied. Allow mic access and try again.");
        } else {
          opts.onError?.(e instanceof Error ? e.message : "Could not open microphone");
        }
        opts.onEnd?.();
      }
    })();
  };

  const startBrowser = () => {
    if (!Rec) {
      startWhisperFallback();
      return;
    }
    intentionalStop = false;
    finalized = false;
    try {
      if (rec) {
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        rec = null;
      }
      const r = new Rec();
      r.continuous = false;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";

      r.onstart = () => {
        opts.onStart?.();
        opts.onInterim?.("Listening… speak, then pause");
      };
      r.onresult = (ev) => {
        let interim = "";
        let finalText = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const piece = ev.results[i][0]?.transcript ?? "";
          if (ev.results[i].isFinal) finalText += piece;
          else interim += piece;
        }
        if (interim) opts.onInterim?.(interim);
        if (finalText.trim()) {
          finalized = true;
          opts.onFinal?.(finalText.trim());
        }
      };
      r.onerror = (ev) => {
        const code = ev.error || "error";
        if (code === "aborted" || code === "no-speech") return;
        if (code === "not-allowed") {
          opts.onError?.("Microphone permission denied. Allow mic access and try again.");
          return;
        }
        if (code === "network" && canRecord && !whisperTranscribeDisabled) {
          // Chrome cloud STT failed — fall back to local Whisper path.
          opts.onInterim?.("Browser STT unavailable — trying Whisper…");
          rec = null;
          startWhisperFallback();
          return;
        }
        if (code === "network") {
          opts.onError?.(
            "Speech recognition needs internet (Chrome uses Google's service). LM Studio Whisper is not available on this server.",
          );
          return;
        }
      };
      r.onend = () => {
        rec = null;
        if (usingWhisper) return; // whisper path owns the session
        if (!finalized && !intentionalStop) {
          // ended without final text
          opts.onEnd?.();
        } else if (intentionalStop && !finalized) {
          opts.onEnd?.();
        }
        // if finalized, onFinal already fired; ApexChat will drive the next state
      };
      rec = r;
      r.start();
    } catch (e) {
      opts.onError?.(e instanceof Error ? e.message : "Could not start speech recognition");
      if (canRecord) startWhisperFallback();
    }
  };

  return {
    supported: true,
    start(startOpts) {
      if (Rec) startBrowser();
      else if (!whisperTranscribeDisabled) startWhisperFallback(startOpts);
      else {
        opts.onError?.(
          "Speech input unavailable. Enable browser speech recognition (internet) or configure Whisper transcription.",
        );
        opts.onEnd?.();
      }
    },
    stop() {
      intentionalStop = true;
      if (usingWhisper || recorder) {
        shouldTranscribe = true;
        clearWhisperTimers();
        try {
          recorder?.requestData?.();
          recorder?.stop();
        } catch {
          cleanupWhisper();
          opts.onEnd?.();
        }
        return;
      }
      if (rec) {
        try {
          rec.stop();
        } catch {
          try {
            rec.abort();
          } catch {
            /* ignore */
          }
        }
      } else {
        opts.onEnd?.();
      }
    },
    cancel() {
      intentionalStop = true;
      finalized = true;
      if (usingWhisper || recorder) {
        shouldTranscribe = false;
        clearWhisperTimers();
        try {
          recorder?.stop();
        } catch {
          /* ignore */
        }
        cleanupWhisper();
        opts.onEnd?.();
        return;
      }
      if (rec) {
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        rec = null;
      }
      opts.onEnd?.();
    },
  };
}
