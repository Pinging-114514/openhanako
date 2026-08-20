import {
  OBSERVATIONAL_CAPTURE_SYSTEM,
  buildObservationalCapturePrompt,
  observationsFromCaptureText,
  shouldCaptureObservationalNotes,
} from "./capture.ts";
import {
  foldObservationalNotes,
  serializeSourceEntries,
  sourceEntriesAfter,
} from "./ledger.ts";
import { OBSERVATIONAL_NOTES_TYPE } from "./types.ts";

export async function captureObservationalNotes({
  entries,
  completeText,
  appendCustomEntry,
}: {
  entries: any[];
  completeText: (input: { systemPrompt: string; prompt: string }) => Promise<string>;
  appendCustomEntry: (customType: string, data: unknown) => void;
}): Promise<{ recorded: number; coveredThroughEntryId: string | null } | null> {
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
  const observations = observationsFromCaptureText(text);
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
