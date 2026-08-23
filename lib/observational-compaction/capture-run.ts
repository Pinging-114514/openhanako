import {
  OBSERVATIONAL_CAPTURE_SYSTEM,
  buildObservationalCapturePrompt,
  shouldCaptureObservationalNotes,
} from "./capture.ts";
import {
  foldObservationalNotes,
  parseObservationsJsonResult,
  serializeSourceEntries,
  sourceEntriesAfter,
} from "./ledger.ts";
import { OBSERVATIONAL_NOTES_TYPE } from "./types.ts";

export function observationalCaptureModelRef(ctx: any): { id: string; provider: string } | null {
  const model = ctx?.model;
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  if (!id || !provider) return null;
  return { id, provider };
}

export type ObservationalCaptureResult = {
  recorded: number;
  coveredThroughEntryId: string | null;
  skipped?: "empty" | "invalid";
  preview?: string;
};

export async function captureObservationalNotes({
  entries,
  completeText,
  appendCustomEntry,
}: {
  entries: any[];
  completeText: (input: { systemPrompt: string; prompt: string }) => Promise<string>;
  appendCustomEntry: (customType: string, data: unknown) => void;
}): Promise<ObservationalCaptureResult | null> {
  const folded = foldObservationalNotes(entries);
  const chunkEntries = sourceEntriesAfter(entries, folded.coveredThroughEntryId);
  const chunk = serializeSourceEntries(chunkEntries);
  if (!shouldCaptureObservationalNotes({
    sourceCount: chunkEntries.length,
    chunkChars: chunk.length,
  })) {
    return null;
  }
  const prompt = buildObservationalCapturePrompt({
    existing: folded.observations,
    chunk,
  });
  const text = await completeText({
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
  return { recorded: observations.length, coveredThroughEntryId };
}
