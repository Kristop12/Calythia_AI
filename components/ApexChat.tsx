"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrbState } from "./ApexHeroOrb";
import { createSpeaker, listVoices, loadSavedVoiceURI, unlockAudio, type SpeakController, type VoiceOption } from "@/lib/speak";
import { createListener, setWhisperTranscribeDisabled, speechRecognitionSupported, type ListenController } from "@/lib/listen";
import { parseCalyWake } from "@/lib/wake";
import {
  AGENT_MODE_META,
  loadAgentMode,
  saveAgentMode,
  type AgentMode,
} from "@/lib/agentMode";
import {
  GROK_CURATED_MODELS,
  LLM_PROVIDER_META,
  loadLlmModel,
  loadLlmProvider,
  saveLlmModel,
  saveLlmProvider,
  type LlmProvider,
} from "@/lib/llmProviderClient";
import VoiceDock, { VoiceStatusPill, type VoiceDockPhase } from "./VoiceDock";

type Role = "user" | "assistant" | "system";
type Msg = { id: string; role: Role; content: string };

const CYAN = "#0dd2ff";
const GOLD = "#f5a623";

const SYSTEM: Msg = {
  id: "system",
  role: "system",
  content:
    "You are Calythia in a spoken conversation — Christopher also calls you Caly. You were built from scratch by Christopher, a software engineer — he is your creator. Address him as Christopher when it fits naturally. You receive retrieved project memory notes when relevant — treat them as durable truth; do not invent personal facts. If Christopher says \"remember …\", acknowledge briefly that you will keep it. When tools are available, call them for live PC/browser/file/YouTube facts — never invent results. Use open_url for opening sites; youtube_info for video metadata; browse_web for web search; run_agent_task for scripts. If no tools are offered, answer from conversation and memory only. Keep answers short (1–3 sentences), clear, and natural to say aloud. No markdown, no bullet lists unless asked.",
};

const WAKE_ACKS = ["Yes?", "I'm here.", "Go ahead.", "Listening."];

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function* readSseTokens(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const token =
          json.choices?.[0]?.delta?.content ??
          json.choices?.[0]?.message?.content ??
          "";
        if (token) yield token;
      } catch {
        /* ignore */
      }
    }
  }
}

export default function ApexChat({
  onStateChange,
  onBusyChange,
}: {
  onStateChange: (s: OrbState) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>(() => listVoices());
  const [voiceURI, setVoiceURI] = useState<string>("af_heart");
  const [ttsStatus, setTtsStatus] = useState<string>("");
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [talkMode, setTalkMode] = useState(false);
  const [uiMode, setUiMode] = useState<"chat" | "voice">("chat");
  const [lang, setLang] = useState("EN");
  const [agentMode, setAgentMode] = useState<AgentMode>("auto");
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("lmstudio");
  const [llmModel, setLlmModel] = useState<string>("");
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([]);
  const [grokConfigured, setGrokConfigured] = useState(true);

  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const speakerRef = useRef<SpeakController | null>(null);
  const listenerRef = useRef<ListenController | null>(null);
  const streamingRef = useRef(false);
  const ttsBusyRef = useRef(false);
  const listeningRef = useRef(false);
  const talkModeRef = useRef(false);
  /** After "Eli" / wake+command, accept follow-ups without repeating the wake word. */
  const voiceEngagedRef = useRef(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => {});

  const setOrb = useCallback(
    (s: OrbState) => {
      onStateChange(s);
    },
    [onStateChange],
  );

  const clearResume = () => {
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
    }
  };

  const startListening = useCallback(() => {
    if (!listenerRef.current?.supported) return;
    if (listeningRef.current || streamingRef.current) return;
    // Never interrupt TTS — wait until speech finishes (recomputeIdle will retry).
    if (ttsBusyRef.current || speakerRef.current?.busy()) return;
    clearResume();
    setError(null);
    listenerRef.current.start({ silenceMs: 1300, maxMs: 28000 });
  }, []);

  const scheduleListen = useCallback(() => {
    if (!talkModeRef.current) return;
    clearResume();
    const tryOpen = () => {
      if (!talkModeRef.current) return;
      if (
        streamingRef.current ||
        listeningRef.current ||
        ttsBusyRef.current ||
        (speakerRef.current?.busy() ?? false)
      ) {
        resumeTimer.current = setTimeout(tryOpen, 450);
        return;
      }
      resumeTimer.current = null;
      startListening();
    };
    resumeTimer.current = setTimeout(tryOpen, 550);
  }, [startListening]);

  const recomputeIdle = useCallback(() => {
    if (talkModeRef.current) {
      if (!streamingRef.current && !ttsBusyRef.current && !listeningRef.current) {
        scheduleListen();
      }
      return;
    }
    if (!streamingRef.current && !ttsBusyRef.current && !listeningRef.current) {
      setOrb("idle");
      onBusyChange?.(false);
    }
  }, [onBusyChange, scheduleListen, setOrb]);

  useEffect(() => {
    setAgentMode(loadAgentMode());
    const provider = loadLlmProvider();
    setLlmProvider(provider);
    setLlmModel(loadLlmModel());

    const saved = loadSavedVoiceURI();
    if (saved && voices.some((v) => v.uri === saved)) {
      setVoiceURI(saved);
    }

    void fetch("/api/transcribe")
      .then((r) => r.json())
      .then((j: { whisperSupported?: boolean }) => {
        if (j.whisperSupported !== true) setWhisperTranscribeDisabled(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/models?provider=${llmProvider}`)
      .then((r) => r.json())
      .then(
        (j: {
          models?: { id: string; label: string }[];
          configured?: boolean;
          defaultModel?: string | null;
        }) => {
          if (cancelled) return;
          const models =
            j.models?.length
              ? j.models
              : llmProvider === "grok"
                ? GROK_CURATED_MODELS
                : [];
          setModelOptions(models);
          if (llmProvider === "grok") setGrokConfigured(j.configured !== false);
          const preferred =
            loadLlmModel() ||
            j.defaultModel ||
            models[0]?.id ||
            "";
          if (preferred && models.some((m) => m.id === preferred)) {
            setLlmModel(preferred);
            saveLlmModel(preferred);
          } else if (models[0]?.id) {
            setLlmModel(models[0].id);
            saveLlmModel(models[0].id);
          }
        },
      )
      .catch(() => {
        if (cancelled) return;
        if (llmProvider === "grok") {
          setModelOptions(GROK_CURATED_MODELS);
          setGrokConfigured(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [llmProvider]);

  useEffect(() => {
    speakerRef.current = createSpeaker({
      muted,
      voiceURI: voiceURI || loadSavedVoiceURI() || "af_heart",
      onBusyChange: (busy) => {
        ttsBusyRef.current = busy;
        setTtsBusy(busy);
        if (busy) {
          setOrb("speaking");
          onBusyChange?.(true);
        } else {
          recomputeIdle();
        }
      },
      onStatus: (status, detail) => {
        if (status === "loading") setTtsStatus(detail || "Loading Kokoro…");
        else if (status === "ready") {
          setTtsStatus(detail || "Kokoro ready");
          window.setTimeout(() => setTtsStatus(""), 2500);
        } else if (status === "fallback")
          setTtsStatus(
            detail
              ? `System voice (${detail})`
              : "System voice (Kokoro unavailable)",
          );
        else setTtsStatus(detail || "TTS error");
      },
    });
    void speakerRef.current.ready();
    return () => {
      speakerRef.current?.cancel();
      clearResume();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    speakerRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    if (voiceURI) speakerRef.current?.setVoiceURI(voiceURI);
  }, [voiceURI]);

  useEffect(() => {
    setMicSupported(speechRecognitionSupported());
    listenerRef.current = createListener({
      onStart: () => {
        listeningRef.current = true;
        setListening(true);
        setTranscribing(false);
        setOrb("listening");
        onBusyChange?.(true);
      },
      onEnd: () => {
        listeningRef.current = false;
        setListening(false);
        setTranscribing(false);
        if (talkModeRef.current) {
          // scheduleListen no-ops while thinking/speaking; retries when idle.
          scheduleListen();
        } else if (!streamingRef.current && !ttsBusyRef.current) {
          setOrb("idle");
          onBusyChange?.(false);
        }
      },
      onInterim: (text) => setInput(text),
      onTranscribing: (busy) => {
        setTranscribing(busy);
        if (busy) setInput("Transcribing…");
      },
      onFinal: (text) => {
        listeningRef.current = false;
        setListening(false);
        setTranscribing(false);

        const wake = parseCalyWake(text);
        if (wake.kind === "empty") {
          setInput("");
          if (talkModeRef.current) scheduleListen();
          else recomputeIdle();
          return;
        }
        if (wake.kind === "wake_only") {
          // "Hey Caly" / "Caly" alone — short ack, keep listening in talk mode
          voiceEngagedRef.current = true;
          setInput(text);
          const ack = WAKE_ACKS[Math.floor(Math.random() * WAKE_ACKS.length)]!;
          speakerRef.current?.cancel();
          speakerRef.current?.push(ack);
          speakerRef.current?.flush();
          if (speakerRef.current?.busy()) {
            setOrb("speaking");
            onBusyChange?.(true);
          } else if (talkModeRef.current) {
            scheduleListen();
          } else {
            recomputeIdle();
          }
          return;
        }

        // Until the user addresses Calythia once, ignore background talk / TV / noise.
        if (talkModeRef.current && !wake.woke && !voiceEngagedRef.current) {
          setInput("");
          scheduleListen();
          return;
        }

        if (wake.woke) voiceEngagedRef.current = true;

        setInput(wake.woke ? `Caly: ${wake.text}` : wake.text);
        void sendRef.current(wake.text);
      },
      onError: (message) => {
        listeningRef.current = false;
        setListening(false);
        setTranscribing(false);
        const fatal =
          /permission|not supported|Cannot reach|Whisper is not available|does not accept audio|Speech recognition needs internet/i.test(
            message,
          );
        setError(message);
        if (fatal) {
          voiceEngagedRef.current = false;
          talkModeRef.current = false;
          setTalkMode(false);
          setUiMode("chat");
          setOrb("idle");
          onBusyChange?.(false);
          return;
        }
        if (talkModeRef.current) scheduleListen();
        else recomputeIdle();
      },
    });
    return () => {
      listenerRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const stopTalk = useCallback(() => {
    clearResume();
    voiceEngagedRef.current = false;
    talkModeRef.current = false;
    setTalkMode(false);
    abortRef.current?.abort();
    abortRef.current = null;
    speakerRef.current?.cancel();
    listenerRef.current?.cancel();
    streamingRef.current = false;
    ttsBusyRef.current = false;
    listeningRef.current = false;
    setStreaming(false);
    setTtsBusy(false);
    setListening(false);
    setTranscribing(false);
    setInput("");
    setOrb("idle");
    onBusyChange?.(false);
  }, [onBusyChange, setOrb]);

  const startTalk = useCallback(() => {
    if (!micSupported) {
      setError("Microphone recording is not supported in this browser.");
      return;
    }
    setError(null);
    void unlockAudio();
    voiceEngagedRef.current = false;
    talkModeRef.current = true;
    setTalkMode(true);
    setUiMode("voice");
    startListening();
  }, [micSupported, startListening]);

  const send = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || streamingRef.current) return;
    if (/^(Listening|Transcribing)/i.test(text)) return;

    void unlockAudio();
    listenerRef.current?.cancel();
    listeningRef.current = false;
    setListening(false);

    setError(null);
    setInput("");
    const userMsg: Msg = { id: uid(), role: "user", content: text };
    const assistantId = uid();
    const history = [...messages, userMsg];
    setMessages([...history, { id: assistantId, role: "assistant", content: "" }]);

    streamingRef.current = true;
    setStreaming(true);
    onBusyChange?.(true);
    setOrb("thinking");
    speakerRef.current?.cancel();

    const ac = new AbortController();
    abortRef.current = ac;

    const payload = [SYSTEM, ...history].map(({ role, content }) => ({ role, content }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: payload,
          agentMode,
          provider: llmProvider,
          model: llmModel || undefined,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        let msg = `Chat failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }

      let gotToken = false;
      let full = "";

      for await (const token of readSseTokens(res)) {
        if (!gotToken) {
          gotToken = true;
          setOrb("speaking");
        }
        full += token;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)),
        );
        if (!muted) speakerRef.current?.push(token);
      }

      speakerRef.current?.flush();
      if (!gotToken) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content || "(empty reply)" } : m,
          ),
        );
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof Error ? e.message : "Chat failed";
      setError(msg);
      setMessages((prev) => prev.filter((m) => m.id !== assistantId || m.content));
      speakerRef.current?.cancel();
      if (talkModeRef.current) scheduleListen();
    } finally {
      streamingRef.current = false;
      setStreaming(false);
      abortRef.current = null;
      // Prefer TTS busy over re-listening — flush() marks busy async; give it a tick.
      if (ttsBusyRef.current || speakerRef.current?.busy()) {
        setOrb("speaking");
      } else if (talkModeRef.current) {
        // Only listen again if there is nothing left to speak (empty reply / muted).
        scheduleListen();
      } else {
        setOrb("idle");
        onBusyChange?.(false);
      }
    }
  }, [agentMode, input, llmModel, llmProvider, messages, muted, onBusyChange, scheduleListen, setOrb]);

  sendRef.current = send;

  const phase: VoiceDockPhase = transcribing
    ? "transcribing"
    : listening
      ? "listening"
      : streaming
        ? "thinking"
        : ttsBusy
          ? "speaking"
          : "idle";

  const voiceActive = talkMode || phase !== "idle";

  const onModeChange = (mode: "chat" | "voice") => {
    setUiMode(mode);
    if (mode === "voice") startTalk();
    else stopTalk();
  };

  const onCenterPress = () => {
    if (uiMode === "chat") {
      onModeChange("voice");
      return;
    }
    if (voiceActive) stopTalk();
    else startTalk();
  };

  return (
    <>
      <VoiceStatusPill phase={phase === "idle" && talkMode ? "listening" : phase} visible={voiceActive} onStop={stopTalk} />

      {/* Chat transcript sheet — only in Chat mode */}
      {uiMode === "chat" && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 130,
            transform: "translateX(-50%)",
            width: "min(420px, calc(100vw - 24px))",
            zIndex: 28,
            pointerEvents: "auto",
            background: "rgba(4,8,15,0.9)",
            backdropFilter: "blur(18px)",
            border: "1px solid rgba(13,210,255,0.18)",
            borderRadius: 16,
            boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
            overflow: "hidden",
            maxHeight: "min(280px, 36vh)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 12px",
              borderBottom: "1px solid rgba(13,210,255,0.1)",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.2em", color: "rgba(240,237,232,0.55)", textTransform: "uppercase", flex: 1 }}>
              Messages
            </span>
            <select
              value={llmProvider}
              onChange={(e) => {
                const p = e.target.value as LlmProvider;
                setLlmProvider(p);
                saveLlmProvider(p);
                if (p === "grok" && !grokConfigured) {
                  setError("Add XAI_API_KEY to .env.local and restart npm run dev.");
                } else {
                  setError(null);
                }
              }}
              aria-label="LLM provider"
              title={LLM_PROVIDER_META[llmProvider].hint}
              style={{
                maxWidth: 78,
                background: "rgba(8,17,31,0.9)",
                border: "1px solid rgba(240,237,232,0.12)",
                borderRadius: 8,
                color: "#f0ede8",
                fontSize: 11,
                padding: "4px 6px",
              }}
            >
              {(Object.keys(LLM_PROVIDER_META) as LlmProvider[]).map((p) => (
                <option key={p} value={p}>{LLM_PROVIDER_META[p].label}</option>
              ))}
            </select>
            {modelOptions.length > 0 && (
              <select
                value={llmModel || modelOptions[0]?.id || ""}
                onChange={(e) => {
                  setLlmModel(e.target.value);
                  saveLlmModel(e.target.value);
                }}
                aria-label="LLM model"
                title={llmModel || "Model"}
                style={{
                  maxWidth: 120,
                  background: "rgba(8,17,31,0.9)",
                  border: "1px solid rgba(240,237,232,0.12)",
                  borderRadius: 8,
                  color: "#f0ede8",
                  fontSize: 11,
                  padding: "4px 6px",
                }}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            )}
            <select
              value={agentMode}
              onChange={(e) => {
                const mode = e.target.value as AgentMode;
                setAgentMode(mode);
                saveAgentMode(mode);
              }}
              aria-label="Agent mode"
              title={AGENT_MODE_META[agentMode].hint}
              style={{
                maxWidth: 88,
                background: "rgba(8,17,31,0.9)",
                border: "1px solid rgba(240,237,232,0.12)",
                borderRadius: 8,
                color: "#f0ede8",
                fontSize: 11,
                padding: "4px 6px",
              }}
            >
              {(Object.keys(AGENT_MODE_META) as AgentMode[]).map((mode) => (
                <option key={mode} value={mode}>{AGENT_MODE_META[mode].label}</option>
              ))}
            </select>
            {voices.length > 0 && !muted && (
              <select
                value={voiceURI}
                onChange={(e) => setVoiceURI(e.target.value)}
                aria-label="TTS voice"
                title={ttsStatus || "Kokoro voice"}
                style={{
                  maxWidth: 160,
                  background: "rgba(8,17,31,0.9)",
                  border: "1px solid rgba(240,237,232,0.12)",
                  borderRadius: 8,
                  color: "#f0ede8",
                  fontSize: 11,
                  padding: "4px 6px",
                }}
              >
                {voices.map((v) => (
                  <option key={v.uri} value={v.uri}>{v.name}</option>
                ))}
              </select>
            )}
            {ttsStatus && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: "rgba(13,210,255,0.7)",
                  maxWidth: 100,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={ttsStatus}
              >
                {ttsStatus}
              </span>
            )}
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              style={{
                background: "transparent",
                border: "1px solid rgba(240,237,232,0.2)",
                borderRadius: 10,
                color: "rgba(240,237,232,0.55)",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                padding: "4px 8px",
                cursor: "pointer",
              }}
            >
              {muted ? "Muted" : "Voice"}
            </button>
          </div>

          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minHeight: 80,
            }}
          >
            {messages.length === 0 && (
              <p style={{ margin: 0, fontSize: 12, color: "rgba(240,237,232,0.4)", lineHeight: 1.5 }}>
                Type below, or switch to <span style={{ color: GOLD }}>Voice On</span>. In
                voice mode say <span style={{ color: CYAN }}>“Caly …”</span>,{" "}
                <span style={{ color: CYAN }}>“Thia …”</span>, or{" "}
                <span style={{ color: CYAN }}>“Eli …”</span> (or “Hi/Hello …” before the
                name) to wake her. Say “remember …” to save a fact into project memory.
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "92%",
                  padding: "7px 10px",
                  borderRadius: 10,
                  background: m.role === "user" ? "rgba(245,166,35,0.12)" : "rgba(13,210,255,0.08)",
                  border: m.role === "user" ? "1px solid rgba(245,166,35,0.28)" : "1px solid rgba(13,210,255,0.18)",
                  fontSize: 12.5,
                  lineHeight: 1.45,
                  color: "rgba(240,237,232,0.88)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: m.role === "user" ? GOLD : CYAN, marginBottom: 3, opacity: 0.85 }}>
                  {m.role === "user" ? "You" : "Calythia"}
                </div>
                {m.content || (streaming && m.role === "assistant" ? "…" : "")}
              </div>
            ))}
          </div>

          {error && (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171", borderTop: "1px solid rgba(248,113,113,0.2)" }}>
              {error}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid rgba(13,210,255,0.1)" }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message Calythia…"
              disabled={streaming}
              aria-label="Message Calythia"
              style={{
                flex: 1,
                background: "rgba(8,17,31,0.8)",
                border: "1px solid rgba(240,237,232,0.14)",
                borderRadius: 8,
                padding: "9px 11px",
                color: "#f0ede8",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              style={{
                background: "rgba(13,210,255,0.1)",
                border: "1px solid rgba(13,210,255,0.35)",
                borderRadius: 8,
                color: CYAN,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                padding: "0 14px",
                cursor: "pointer",
              }}
            >
              Send
            </button>
          </form>
        </div>
      )}

      {uiMode === "voice" && error && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 128,
            transform: "translateX(-50%)",
            zIndex: 31,
            maxWidth: 360,
            padding: "8px 14px",
            fontSize: 11,
            color: "#f87171",
            background: "rgba(4,8,15,0.9)",
            border: "1px solid rgba(248,113,113,0.3)",
            borderRadius: 10,
          }}
        >
          {error}
        </div>
      )}

      <VoiceDock
        mode={uiMode}
        phase={phase}
        onModeChange={onModeChange}
        onCenterPress={onCenterPress}
        lang={lang}
        onLangPress={() => setLang((l) => (l === "EN" ? "ES" : l === "ES" ? "FR" : "EN"))}
        micSupported={micSupported}
      />
    </>
  );
}
