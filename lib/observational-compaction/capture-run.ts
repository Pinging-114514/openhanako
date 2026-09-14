import {
  OBSERVATIONAL_CAPTURE_SYSTEM,
  buildObservationalCapturePrompt,
  observationalChunkHasUserMessage,
  shouldCaptureObservationalNotes,
} from "./capture.ts";
import {
  foldObservationalNotes,
  parseObservationsJsonResult,
  serializeSourceEntries,
  sourceEntriesAfter,
} from "./ledger.ts";
import { OBSERVATIONAL_NOTES_TYPE } from "./types.ts";

export type ObservationalCaptureLane = "primary" | "utility";

export type ObservationalCaptureCompleteInput = {
  systemPrompt: string;
  prompt: string;
  lane: ObservationalCaptureLane;
};

export function observationalCaptureModelRef(ctx: any): { id: string; provider: string } | null {
  const model = ctx?.model;
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  if (!id || !provider) return null;
  return { id, provider };
}

export function observationalCaptureModelKey(ref: { id?: string; provider?: string } | null | undefined): string {
  const id = typeof ref?.id === "string" ? ref.id.trim().toLowerCase() : "";
  const provider = typeof ref?.provider === "string" ? ref.provider.trim().toLowerCase() : "";
  return id ? `${provider}::${id}` : "";
}

export function observationalUtilityMatchesSession(
  sessionRef: { id?: string; provider?: string } | null | undefined,
  utilityModel: { id?: string; provider?: string } | null | undefined,
): boolean {
  const session = observationalCaptureModelKey(sessionRef);
  const utility = observationalCaptureModelKey(utilityModel);
  return Boolean(session && utility && session === utility);
}

export function isObservationalUtilityUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /observational capture utility (is not configured|matches the session model)/i.test(message);
}

export type ObservationalCaptureResult = {
  recorded: number;
  coveredThroughEntryId: string | null;
  skipped?: "empty" | "invalid";
  preview?: string;
  via?: ObservationalCaptureLane;
};

function captureTextUsable(text: string): boolean {
  const parsed = parseObservationsJsonResult(text);
  return parsed.status === "ok" && parsed.observations.length > 0;
}

async function completeObservationalCaptureText(
  completeText: (input: ObservationalCaptureCompleteInput) => Promise<string>,
  input: { systemPrompt: string; prompt: string },
): Promise<{ text: string; via: ObservationalCaptureLane }> {
  let primaryText = "";
  let primaryError: unknown = null;
  try {
    primaryText = await completeText({ ...input, lane: "primary" });
    if (captureTextUsable(primaryText)) return { text: primaryText, via: "primary" };
  } catch (error) {
    primaryError = error;
  }
  try {
    const utilityText = await completeText({ ...input, lane: "utility" });
    return { text: utilityText, via: "utility" };
  } catch (error) {
    if (primaryError && isObservationalUtilityUnavailable(error)) throw primaryError;
    if (primaryError && !primaryText) throw primaryError;
    if (isObservationalUtilityUnavailable(error) && primaryText) {
      return { text: primaryText, via: "primary" };
    }
    throw error;
  }
}

export async function captureObservationalNotes({
  entries,
  completeText,
  appendCustomEntry,
}: {
  entries: any[];
  completeText: (input: ObservationalCaptureCompleteInput) => Promise<string>;
  appendCustomEntry: (customType: string, data: unknown) => void;
}): Promise<ObservationalCaptureResult | null> {
  const folded = foldObservationalNotes(entries);
  const chunkEntries = sourceEntriesAfter(entries, folded.coveredThroughEntryId);
  const chunk = serializeSourceEntries(chunkEntries);
  if (!shouldCaptureObservationalNotes({
    sourceCount: chunkEntries.length,
    chunkChars: chunk.length,
    hasUserMessage: observationalChunkHasUserMessage(chunkEntries),
  })) {
    return null;
  }
  const prompt = buildObservationalCapturePrompt({
    existing: folded.observations,
    chunk,
  });
  const { text, via } = await completeObservationalCaptureText(completeText, {
    systemPrompt: OBSERVATIONAL_CAPTURE_SYSTEM,
    prompt,
  });
  const parsed = parseObservationsJsonResult(text);
  const preview = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (parsed.status !== "ok" || parsed.observations.length === 0) {
    return {
      recorded: 0,
      coveredThroughEntryId: folded.coveredThroughEntryId,
      skipped: parsed.status === "invalid" ? "invalid" : "empty",
      preview,
      via,
    };
  }
  const observations = parsed.observations.slice(0, 16);
  const lastId = chunkEntries[chunkEntries.length - 1]?.id;
  const coveredThroughEntryId = typeof lastId === "string" && lastId.trim()
    ? lastId.trim()
    : folded.coveredThroughEntryId;
  appendCustomEntry(OBSERVATIONAL_NOTES_TYPE, {
    schema: 1,
    observations,
    coveredThroughEntryId,
  });
  return { recorded: observations.length, coveredThroughEntryId, via };
}
