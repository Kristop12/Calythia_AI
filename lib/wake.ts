/**
 * Wake / address phrases for Calythia ("Caly" / "Thia" / "Eli" shortcuts).
 * Strips leading greetings so spoken commands reach the model cleanly.
 */

/** Spoken names + common STT mishearings */
const NAME = String.raw`(?:calythia|caly|callie|cali|kali|kelly|kaylee|thia|eli|elly|ellie)`;

/** Optional greeting before the name — allows "Hi," / "Hello," from STT */
const GREET = String.raw`(?:hey|hi|hello|ok|okay|yo|excuse\s+me)`;

/**
 * Leading: "hey caly …", "hi, thia …", "hello eli …", "caly …"
 * Comma/period between greet and name is common from Chrome STT.
 */
const LEADING = new RegExp(
  `^\\s*(?:${GREET}\\s*[,!.?]?\\s+)?${NAME}\\b[,!.?]?\\s*`,
  "i",
);

/** Entire utterance is just the wake / name */
const WAKE_ONLY = new RegExp(
  `^\\s*(?:${GREET}\\s*[,!.?]?\\s+)?${NAME}\\b[,!.?]?\\s*$`,
  "i",
);

export type WakeParse =
  | { kind: "wake_only" }
  | { kind: "command"; text: string; woke: boolean }
  | { kind: "empty" };

export function parseCalyWake(raw: string): WakeParse {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { kind: "empty" };

  if (WAKE_ONLY.test(text)) return { kind: "wake_only" };

  if (LEADING.test(text)) {
    const stripped = text.replace(LEADING, "").trim();
    if (!stripped) return { kind: "wake_only" };
    return { kind: "command", text: stripped, woke: true };
  }

  return { kind: "command", text, woke: false };
}

export function isCalyWakePhrase(raw: string): boolean {
  const p = parseCalyWake(raw);
  return p.kind === "wake_only" || (p.kind === "command" && p.woke);
}
