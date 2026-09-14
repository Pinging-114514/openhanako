import { parseObservationsJson, serializeSourceEntries } from "./ledger.ts";
import type { Observation } from "./types.ts";

export const OBSERVATIONAL_CAPTURE_SYSTEM = `You extract durable session observations for a coding assistant.
After compaction, these observations are the ONLY memory of older turns.
Return JSON only: an array of objects with keys content, relevance.
relevance must be high, medium, or low.
Rules:
- New facts only. Do not repeat what is already listed.
- One fact per observation. Plain prose, no markdown.
- Preserve user assertions as assertions, questions as questions.
- Mark completed work with "completed:".
- Group similar tool calls.
- Prefer short facts over none. If the chunk contains a user message, return at least one observation about what the user asked, decided, or rejected.
- Return [] only when the chunk has no user or assistant substance.`;

export function buildObservationalCapturePrompt({
  existing,
  chunk,
}: {
  existing: Observation[];
  chunk: string;
}): string {
  const known = existing.slice(-40).map((item) => `- ${item.content}`).join("\n") || "(none)";
  return `Already recorded observations:
${known}

New conversation chunk:
${chunk}

Return JSON array only.`;
}

export function observationsFromCaptureText(text: string): Observation[] {
  return parseObservationsJson(text).slice(0, 16);
}

export { parseObservationsJsonResult } from "./ledger.ts";

export const OBSERVATIONAL_CAPTURE_MIN_SOURCES = 6;
export const OBSERVATIONAL_CAPTURE_MIN_CHARS = 4000;
export const OBSERVATIONAL_CAPTURE_COOLDOWN_MS = 3 * 60 * 1000;

export function observationalChunkHasUserMessage(entries: any[]): boolean {
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    const role = entry?.message?.role || entry?.role;
    return role === "user";
  });
}

export function shouldCaptureObservationalNotes({
  sourceCount,
  chunkChars,
  hasUserMessage = true,
}: {
  sourceCount: number;
  chunkChars: number;
  hasUserMessage?: boolean;
}): boolean {
  if (!hasUserMessage || sourceCount <= 0 || chunkChars <= 0) return false;
  return sourceCount >= OBSERVATIONAL_CAPTURE_MIN_SOURCES || chunkChars >= OBSERVATIONAL_CAPTURE_MIN_CHARS;
}

export function observationalCaptureOnCooldown(lastAttemptAt: number | null | undefined, now = Date.now()): boolean {
  const previous = Number(lastAttemptAt);
  return Number.isFinite(previous) && previous > 0 && now - previous < OBSERVATIONAL_CAPTURE_COOLDOWN_MS;
}

export { serializeSourceEntries };
