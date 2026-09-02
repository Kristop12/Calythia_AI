"use client";

import type { CSSProperties } from "react";

const GOLD = "#f5a623";
const GOLD_SOFT = "#e8c078";

export type VoiceDockPhase = "idle" | "listening" | "thinking" | "speaking" | "transcribing";

type Props = {
  mode: "chat" | "voice";
  phase: VoiceDockPhase;
  onModeChange: (mode: "chat" | "voice") => void;
  onCenterPress: () => void;
  lang?: string;
  onLangPress?: () => void;
  micSupported?: boolean;
};

function phaseLabel(phase: VoiceDockPhase) {
  switch (phase) {
    case "listening":
      return "LISTENING";
    case "transcribing":
      return "TRANSCRIBING";
    case "thinking":
      return "THINKING";
    case "speaking":
      return "SPEAKING";
    default:
      return "STANDBY";
  }
}

function WaveBars({ active }: { active: boolean }) {
  const bars = 22;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, height: 36 }} aria-hidden>
      {Array.from({ length: bars }, (_, i) => {
        const dist = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2);
        const h = active ? 8 + (1 - dist) * 22 : 4 + (1 - dist) * 6;
        return (
          <span
            key={i}
            style={{
              width: 2.5,
              height: h,
              borderRadius: 2,
              background: GOLD,
              opacity: active ? 0.85 - dist * 0.35 : 0.28,
              transformOrigin: "center",
              animation: active
                ? `vdBar ${0.45 + (i % 5) * 0.12}s ease-in-out ${(i % 7) * 0.05}s infinite alternate`
                : "none",
            }}
          />
        );
      })}
    </div>
  );
}

/** Bottom voice/chat dock matching the Calythia reference bar. */
export default function VoiceDock({
  mode,
  phase,
  onModeChange,
  onCenterPress,
  lang = "EN",
  onLangPress,
  micSupported = true,
}: Props) {
  const active = phase !== "idle";
  const label = phaseLabel(phase);
  const dotIndex = phase === "listening" || phase === "transcribing" ? 0 : phase === "thinking" ? 1 : phase === "speaking" ? 2 : 0;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 30,
        pointerEvents: "none",
        padding: "0 clamp(12px, 3vw, 28px) 22px",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <style>{`
        @keyframes vdBar { from { transform: scaleY(0.35); } to { transform: scaleY(1.2); } }
        @keyframes vdPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(245,166,35,0.45); } 50% { box-shadow: 0 0 0 10px rgba(245,166,35,0); } }
      `}</style>

      <div
        style={{
          width: "min(920px, 100%)",
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: 12,
          pointerEvents: "auto",
        }}
      >
        {/* Chat / Voice toggle */}
        <div style={{ justifySelf: "start" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 4,
              borderRadius: 999,
              background: "rgba(8,14,24,0.82)",
              border: "1px solid rgba(240,237,232,0.12)",
              backdropFilter: "blur(14px)",
            }}
          >
            <button
              type="button"
              onClick={() => onModeChange("chat")}
              aria-pressed={mode === "chat"}
              style={{
                ...segBtn,
                color: mode === "chat" ? GOLD : "rgba(240,237,232,0.55)",
                background: mode === "chat" ? "rgba(245,166,35,0.14)" : "transparent",
              }}
            >
              <ChatIcon />
              Chat
            </button>
            <button
              type="button"
              onClick={() => micSupported && onModeChange("voice")}
              disabled={!micSupported}
              aria-pressed={mode === "voice"}
              style={{
                ...segBtn,
                color: mode === "voice" ? GOLD : "rgba(240,237,232,0.55)",
                background: mode === "voice" ? "rgba(40,48,60,0.95)" : "transparent",
                boxShadow: mode === "voice" ? "inset 0 0 0 1px rgba(245,166,35,0.25)" : "none",
                opacity: micSupported ? 1 : 0.4,
              }}
            >
              <MicIcon />
              {mode === "voice" ? "Voice On" : "Voice"}
            </button>
          </div>
        </div>

        {/* Center waveform cluster */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <WaveBars active={active} />
            <button
              type="button"
              onClick={onCenterPress}
              aria-label={active ? "Stop" : mode === "voice" ? "Start listening" : "Open voice"}
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                border: `2px solid ${active ? GOLD : "rgba(240,237,232,0.35)"}`,
                background: "#0a1018",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
                animation: active ? "vdPulse 1.6s ease-out infinite" : "none",
                boxShadow: active ? `0 0 18px rgba(245,166,35,0.35)` : "none",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: active ? "#fff" : GOLD_SOFT,
                  boxShadow: active ? "0 0 10px rgba(255,255,255,0.8)" : `0 0 8px ${GOLD}`,
                }}
              />
            </button>
            <WaveBars active={active} />
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.42em",
              color: "rgba(240,237,232,0.78)",
              textTransform: "uppercase",
            }}
          >
            {label}
          </div>
          <div style={{ display: "flex", gap: 7 }} aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: i === dotIndex ? "#fff" : "transparent",
                  border: i === dotIndex ? "none" : "1px solid rgba(240,237,232,0.35)",
                }}
              />
            ))}
          </div>
        </div>

        {/* Language */}
        <div style={{ justifySelf: "end" }}>
          <button
            type="button"
            onClick={onLangPress}
            aria-label={`Language ${lang}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              borderRadius: 999,
              background: "rgba(8,14,24,0.82)",
              border: "1px solid rgba(240,237,232,0.12)",
              color: "rgba(240,237,232,0.8)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              letterSpacing: "0.12em",
              cursor: onLangPress ? "pointer" : "default",
              backdropFilter: "blur(14px)",
            }}
          >
            <GlobeIcon />
            {lang}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Top status pill — SPEAKING / LISTENING - TAP TO STOP */
export function VoiceStatusPill({
  phase,
  visible,
  onStop,
}: {
  phase: VoiceDockPhase;
  visible: boolean;
  onStop: () => void;
}) {
  if (!visible) return null;
  const text =
    phase === "listening" || phase === "transcribing"
      ? "LISTENING — TAP TO STOP"
      : phase === "thinking"
        ? "THINKING — TAP TO STOP"
        : phase === "speaking"
          ? "SPEAKING — TAP TO STOP"
          : "VOICE ON — TAP TO STOP";

  return (
    <button
      type="button"
      onClick={onStop}
      style={{
        position: "fixed",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 45,
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 18px",
        borderRadius: 999,
        background: "rgba(6,12,22,0.88)",
        border: "1px solid rgba(240,237,232,0.22)",
        backdropFilter: "blur(12px)",
        color: "rgba(245,235,210,0.92)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        cursor: "pointer",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: GOLD,
          boxShadow: `0 0 10px ${GOLD}`,
        }}
      />
      {text}
    </button>
  );
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H10l-4 3.5V15H7.5A2.5 2.5 0 0 1 5 12.5v-6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 17v3M9 20h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.8 3.8 5.6 3.8 8.5S14.5 17.7 12 20.5C9.5 17.7 8.2 14.9 8.2 12S9.5 6.3 12 3.5Z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const segBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  border: "none",
  borderRadius: 999,
  padding: "9px 14px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  letterSpacing: "0.04em",
  cursor: "pointer",
  background: "transparent",
};
