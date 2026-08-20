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
- If nothing new, return [].`;

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

export function shouldCaptureObservationalNotes({
  sourceCount,
  chunkChars,
}: {
  sourceCount: number;
  chunkChars: number;
}): boolean {
  if (sourceCount <= 0 || chunkChars <= 0) return false;
  return sourceCount >= 2 || chunkChars >= 1200;
}

export { serializeSourceEntries };
