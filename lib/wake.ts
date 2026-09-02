/**
 * Wake / address phrases for Calythia ("Caly" shortcut).
 * Strips leading greetings so spoken commands reach the model cleanly.
 */

const NAME = String.raw`(?:calythia|caly|callie|cali|kali)`;
const GREET = String.raw`(?:hey|hi|hello|ok|okay|yo|excuse\s+me)`;

/** Leading: "hey caly …", "caly …", "hey calythia, …" */
const LEADING = new RegExp(`^\\s*(?:${GREET}\\s+)?${NAME}\\b[,!.?]?\\s*`, "i");

/** Entire utterance is just the wake / name */
const WAKE_ONLY = new RegExp(`^\\s*(?:${GREET}\\s+)?${NAME}\\b[,!.?]?\\s*$`, "i");

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
