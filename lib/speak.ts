/**
 * Calythia TTS — Kokoro (kokoro-js) in the browser, with Web Speech fallback.
 *
 * Buffers the full LLM reply, then speaks (sentence stream → audio).
 */

export type SpeakController = {
  push: (chunk: string) => void;
  flush: () => void;
  cancel: () => void;
  busy: () => boolean;
  setMuted: (muted: boolean) => void;
  setVoiceURI: (uri: string | null) => void;
  ready: () => Promise<void>;
};

export type VoiceOption = {
  uri: string;
  name: string;
  lang: string;
  score: number;
};

export type TtsStatus = "loading" | "ready" | "fallback" | "error";

const VOICE_KEY = "calythia-tts-voice";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** First Hugging Face download can be ~300MB — allow a long window. */
const LOAD_TIMEOUT_MS = 180_000;

const KOKORO_VOICE_META: { id: string; name: string; lang: string; score: number }[] = [
  { id: "af_heart", name: "Kokoro · Heart", lang: "en-US", score: 100 },
  { id: "af_bella", name: "Kokoro · Bella", lang: "en-US", score: 95 },
  { id: "af_nicole", name: "Kokoro · Nicole", lang: "en-US", score: 88 },
  { id: "af_sarah", name: "Kokoro · Sarah", lang: "en-US", score: 82 },
  { id: "af_sky", name: "Kokoro · Sky", lang: "en-US", score: 78 },
  { id: "af_aoede", name: "Kokoro · Aoede", lang: "en-US", score: 76 },
  { id: "am_michael", name: "Kokoro · Michael", lang: "en-US", score: 74 },
  { id: "am_fenrir", name: "Kokoro · Fenrir", lang: "en-US", score: 72 },
  { id: "bf_emma", name: "Kokoro · Emma (UK)", lang: "en-GB", score: 70 },
  { id: "bm_george", name: "Kokoro · George (UK)", lang: "en-GB", score: 68 },
];

const KOKORO_IDS = new Set(KOKORO_VOICE_META.map((v) => v.id));

type RawAudioLike = {
  toBlob: () => Blob;
  audio: Float32Array;
  sampling_rate: number;
};

type KokoroTTSLike = {
  stream: (
    text: { push: (t: string) => void; flush: () => void; close: () => void },
    opts?: { voice?: string; speed?: number },
  ) => AsyncGenerator<{ text: string; phonemes: string; audio: RawAudioLike }>;
  generate: (
    text: string,
    opts?: { voice?: string; speed?: number },
  ) => Promise<RawAudioLike>;
};

type TextSplitterLike = {
  push: (t: string) => void;
  flush: () => void;
  close: () => void;
};

let audioCtx: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let activeEl: HTMLAudioElement | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    audioCtx = new AC();
  }
  return audioCtx;
}

/** Unlock audio from a click/mic gesture so delayed TTS can play. */
export async function unlockAudio(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") await ctx.resume();
  } catch {
    /* ignore */
  }
}

export function listVoices(): VoiceOption[] {
  return KOKORO_VOICE_META.map((v) => ({
    uri: v.id,
    name: v.name,
    lang: v.lang,
    score: v.score,
  }));
}

export function loadSavedVoiceURI(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(VOICE_KEY);
    if (v && KOKORO_IDS.has(v)) return v;
    if (v && !KOKORO_IDS.has(v)) return "af_heart";
    return v;
  } catch {
    return null;
  }
}

export function saveVoiceURI(uri: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (!uri) localStorage.removeItem(VOICE_KEY);
    else localStorage.setItem(VOICE_KEY, uri);
  } catch {
    /* ignore */
  }
}

function normalizeVoice(uri: string | null | undefined): string {
  if (uri && KOKORO_IDS.has(uri)) return uri;
  return "af_heart";
}

/** WebGPU often logs benign ORT warnings (shape ops on CPU). Hide from dev overlay. */
async function suppressOnnxWarnings(): Promise<void> {
  try {
    const { env: tfEnv } = await import("@huggingface/transformers");
    tfEnv.backends.onnx.logLevel = "error";
    tfEnv.useBrowserCache = true;
  } catch {
    /* ignore */
  }
}

type KokoroBundle = {
  tts: KokoroTTSLike;
  TextSplitterStream: new () => TextSplitterLike;
  label: string;
};

let sharedKokoro: KokoroBundle | null = null;
let sharedKokoroMode: "kokoro" | "fallback" | null = null;
let sharedKokoroLoad: Promise<"kokoro" | "fallback"> | null = null;

function kokoroConfig(): {
  device: "webgpu" | "wasm";
  dtype: "fp32" | "q8";
  /** Allow system Web Speech only after Kokoro (incl. wasm/q8) fails. Default on. */
  allowSystemVoice: boolean;
} {
  const deviceRaw = process.env.NEXT_PUBLIC_KOKORO_DEVICE?.trim().toLowerCase();
  const dtypeRaw = process.env.NEXT_PUBLIC_KOKORO_DTYPE?.trim().toLowerCase();
  const device: "webgpu" | "wasm" = deviceRaw === "wasm" ? "wasm" : "webgpu";
  const dtype: "fp32" | "q8" = dtypeRaw === "q8" ? "q8" : "fp32";
  const fb = process.env.NEXT_PUBLIC_KOKORO_FALLBACK?.trim().toLowerCase();
  // Default: allow system voice as last resort. Set FALLBACK=0 to surface hard errors only.
  const allowSystemVoice = fb !== "0" && fb !== "false" && fb !== "no";
  return { device, dtype, allowSystemVoice };
}

/** One Kokoro ONNX load per browser session — shared by every speaker instance. */
async function loadSharedKokoro(
  onStatus?: (status: TtsStatus, detail?: string) => void,
): Promise<"kokoro" | "fallback"> {
  if (sharedKokoroMode === "kokoro" && sharedKokoro) return "kokoro";
  if (sharedKokoroMode === "fallback") return "fallback";
  if (sharedKokoroLoad) return sharedKokoroLoad;

  sharedKokoroLoad = (async () => {
    try {
      await suppressOnnxWarnings();
      onStatus?.("loading", "Loading Kokoro package…");
      const mod = await import("kokoro-js");
      const TextSplitterStreamClass = mod.TextSplitterStream as new () => TextSplitterLike;
      const { device, dtype, allowSystemVoice } = kokoroConfig();

      const load = async (d: "webgpu" | "wasm", dt: "fp32" | "q8") =>
        (await mod.KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: dt,
          device: d,
          progress_callback: (p: {
            status?: string;
            progress?: number;
            file?: string;
          }) => {
            if (p?.status === "progress" && typeof p.progress === "number") {
              const file = p.file ? ` ${p.file.split("/").pop()}` : "";
              onStatus?.(
                "loading",
                `Kokoro ${Math.round(p.progress)}%${file}`,
              );
            } else if (p?.status === "download" || p?.status === "downloading") {
              onStatus?.("loading", "Downloading Kokoro model…");
            }
          },
        })) as unknown as KokoroTTSLike;

      onStatus?.("loading", `Loading Kokoro (${device}/${dtype})…`);

      let instance: KokoroTTSLike;
      let label = `${device}/${dtype}`;
      try {
        instance = await withTimeout(load(device, dtype), LOAD_TIMEOUT_MS, label);
      } catch (primaryErr) {
        // Always try wasm/q8 before giving up — WebGPU often fails on first load.
        if (device === "wasm" && dtype === "q8") throw primaryErr;
        console.warn("[Calythia TTS] primary load failed, trying wasm/q8", primaryErr);
        onStatus?.("loading", "WebGPU failed — trying wasm/q8…");
        instance = await withTimeout(load("wasm", "q8"), LOAD_TIMEOUT_MS, "wasm/q8");
        label = "wasm/q8";
      }

      sharedKokoro = {
        tts: instance,
        TextSplitterStream: TextSplitterStreamClass,
        label,
      };
      sharedKokoroMode = "kokoro";
      onStatus?.("ready", `Kokoro ready (${label})`);
      return "kokoro";
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Kokoro failed to load";
      console.warn("[Calythia TTS]", msg);
      const { allowSystemVoice } = kokoroConfig();
      if (!allowSystemVoice) {
        sharedKokoroMode = null;
        onStatus?.("error", msg);
        throw e;
      }
      sharedKokoroMode = "fallback";
      onStatus?.("fallback", msg);
      return "fallback";
    } finally {
      sharedKokoroLoad = null;
    }
  })();

  return sharedKokoroLoad;
}

/** Clear sticky failed/fallback state so the next speak retries Kokoro. */
export function resetKokoroLoad() {
  sharedKokoro = null;
  sharedKokoroMode = null;
  sharedKokoroLoad = null;
}

/** Warm Kokoro once on app load (reuses browser cache on refresh). */
export function preloadKokoro(
  onStatus?: (status: TtsStatus, detail?: string) => void,
): Promise<void> {
  return loadSharedKokoro(onStatus).then(() => undefined);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function stopPlayback() {
  if (activeSource) {
    try {
      activeSource.stop();
    } catch {
      /* ignore */
    }
    activeSource = null;
  }
  if (activeEl) {
    try {
      activeEl.pause();
      activeEl.src = "";
    } catch {
      /* ignore */
    }
    activeEl = null;
  }
}

async function playRawAudio(
  raw: RawAudioLike,
  getCancelled: () => boolean,
): Promise<void> {
  if (getCancelled()) return;

  // Copy — ONNX may reuse the underlying buffer.
  const samples = new Float32Array(raw.audio);
  const sampleRate = raw.sampling_rate || 24000;
  if (samples.length === 0) return;

  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    if (getCancelled()) return;

    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);

    await new Promise<void>((resolve, reject) => {
      const src = ctx.createBufferSource();
      activeSource = src;
      src.buffer = buffer;
      src.connect(ctx.destination);
      const done = () => {
        if (activeSource === src) activeSource = null;
        clearInterval(poll);
        resolve();
      };
      const poll = setInterval(() => {
        if (getCancelled()) {
          try {
            src.stop();
          } catch {
            /* ignore */
          }
          done();
        }
      }, 80);
      src.onended = done;
      try {
        src.start();
      } catch (e) {
        clearInterval(poll);
        reject(e);
      }
    });
    return;
  } catch (e) {
    console.warn("[Calythia TTS] Web Audio failed, trying <audio>", e);
  }

  if (getCancelled()) return;
  const blob = raw.toBlob?.() ?? float32ToWavBlob(samples, sampleRate);
  const url = URL.createObjectURL(blob);
  try {
    const el = new Audio(url);
    activeEl = el;
    await new Promise<void>((resolve) => {
      const done = () => {
        if (activeEl === el) activeEl = null;
        clearInterval(poll);
        resolve();
      };
      const poll = setInterval(() => {
        if (getCancelled()) {
          try {
            el.pause();
            el.src = "";
          } catch {
            /* ignore */
          }
          done();
        }
      }, 80);
      el.onended = done;
      el.onerror = done;
      void el.play().catch((err) => {
        console.warn("[Calythia TTS] play blocked", err);
        done();
      });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function float32ToWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function createBrowserSpeaker(opts: {
  muted: boolean;
  onBusyChange?: (busy: boolean) => void;
}): SpeakController {
  let buffer = "";
  let muted = opts.muted;
  let pending = 0;
  const notify = () => opts.onBusyChange?.(pending > 0);

  const speak = (text: string) => {
    const t = text.trim();
    if (!t || muted || typeof window === "undefined" || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(t);
    u.rate = 0.96;
    pending += 1;
    notify();
    u.onend = () => {
      pending = Math.max(0, pending - 1);
      notify();
    };
    u.onerror = () => {
      pending = Math.max(0, pending - 1);
      notify();
    };
    window.speechSynthesis.speak(u);
  };

  return {
    push(chunk) {
      if (!chunk || muted) return;
      buffer += chunk;
    },
    flush() {
      if (muted) {
        buffer = "";
        return;
      }
      const text = buffer;
      buffer = "";
      if (text.trim()) speak(text);
    },
    cancel() {
      buffer = "";
      pending = 0;
      window.speechSynthesis?.cancel();
      notify();
    },
    busy: () => pending > 0,
    setMuted(next) {
      muted = next;
      if (next) this.cancel();
    },
    setVoiceURI() {},
    ready: async () => {},
  };
}

export function createSpeaker(opts: {
  muted?: boolean;
  voiceURI?: string | null;
  onBusyChange?: (busy: boolean) => void;
  onStatus?: (status: TtsStatus, detail?: string) => void;
}): SpeakController {
  let muted = !!opts.muted;
  let voice = normalizeVoice(opts.voiceURI ?? loadSavedVoiceURI());
  let pending = 0;
  let generation = 0;

  let tts: KokoroTTSLike | null = null;
  let TextSplitterStream: (new () => TextSplitterLike) | null = null;
  let engine: "kokoro" | "fallback" | "loading" = "loading";
  let browserFallback: SpeakController | null = null;

  let buffer = "";

  const notify = () => opts.onBusyChange?.(pending > 0);

  const bump = (delta: number) => {
    pending = Math.max(0, pending + delta);
    notify();
  };

  const ensureLoaded = (): Promise<"kokoro" | "fallback"> =>
    loadSharedKokoro((status, detail) => opts.onStatus?.(status, detail)).then((mode) => {
      if (mode === "kokoro" && sharedKokoro) {
        tts = sharedKokoro.tts;
        TextSplitterStream = sharedKokoro.TextSplitterStream;
        engine = "kokoro";
      } else if (mode === "fallback") {
        engine = "fallback";
        if (!browserFallback) {
          browserFallback = createBrowserSpeaker({
            muted,
            onBusyChange: opts.onBusyChange,
          });
        }
      }
      return mode;
    });

  if (typeof window !== "undefined") {
    void ensureLoaded();
  }

  const speakText = async (text: string, gen: number) => {
    const t = text.trim();
    if (!t || muted || gen !== generation) return;

    const mode = await ensureLoaded();
    if (gen !== generation || muted) return;

    if (mode === "fallback") {
      browserFallback?.push(t);
      browserFallback?.flush();
      return;
    }
    if (!tts || !TextSplitterStream) return;

    await unlockAudio();

    try {
      const audio = await tts.generate(t, { voice, speed: 1 });
      if (gen !== generation || muted) return;
      await playRawAudio(audio, () => gen !== generation);
    } catch (e) {
      if (gen !== generation) return;
      console.warn("[Calythia TTS] generate failed, trying stream", e);
      try {
        if (!TextSplitterStream) throw e;
        const split = new TextSplitterStream();
        const stream = tts.stream(split, { voice, speed: 1 });

        const consumer = (async () => {
          for await (const { audio } of stream) {
            if (gen !== generation || muted) break;
            await playRawAudio(audio, () => gen !== generation);
          }
        })();

        split.push(t);
        split.flush();
        split.close();
        await consumer;
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : "TTS failed";
        console.warn("[Calythia TTS]", msg);
        opts.onStatus?.("error", msg);
        if (!browserFallback) {
          browserFallback = createBrowserSpeaker({
            muted,
            onBusyChange: opts.onBusyChange,
          });
        }
        engine = "fallback";
        opts.onStatus?.("fallback", msg);
        browserFallback.push(t);
        browserFallback.flush();
      }
    }
  };

  return {
    push(chunk: string) {
      if (!chunk || muted) return;
      buffer += chunk;
    },

    flush() {
      if (muted) {
        buffer = "";
        return;
      }
      const text = buffer;
      buffer = "";
      if (!text.trim()) return;
      const gen = generation;
      // Synchronous busy flag so send()'s finally doesn't re-open the mic / cancel us.
      bump(1);
      void speakText(text, gen).finally(() => bump(-1));
    },

    cancel() {
      generation += 1;
      buffer = "";
      stopPlayback();
      pending = 0;
      notify();
      browserFallback?.cancel();
    },

    busy() {
      if (engine === "fallback") return browserFallback?.busy() ?? false;
      return pending > 0;
    },

    setMuted(next: boolean) {
      muted = next;
      browserFallback?.setMuted(next);
      if (next) this.cancel();
    },

    setVoiceURI(uri: string | null) {
      voice = normalizeVoice(uri);
      saveVoiceURI(voice);
    },

    ready: () => ensureLoaded().then(() => undefined),
  };
}
