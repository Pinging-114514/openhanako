import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureObservationalNotes, observationalCaptureModelRef } from "../lib/observational-compaction/capture-run.ts";
import { observationsFromCaptureText } from "../lib/observational-compaction/capture.ts";
import {
  collectObservationalNoteSources,
  foldObservationalNotes,
  parseObservationsJson,
  parseObservationsJsonResult,
} from "../lib/observational-compaction/ledger.ts";
import { renderObservationalSummary } from "../lib/observational-compaction/render.ts";
import { OBSERVATIONAL_NOTES_TYPE } from "../lib/observational-compaction/types.ts";

describe("observational compaction ledger", () => {
  it("parses JSON observations and folds append-only notes", () => {
    const parsed = parseObservationsJson(`\`\`\`json
[{"content":"User wants observational compaction","relevance":"high"},{"content":"Keep recent tail","relevance":"medium"}]
\`\`\``);
    expect(parseObservationsJsonResult("[]")).toEqual({ status: "empty", observations: [] });
    expect(parseObservationsJsonResult("not json")).toEqual({ status: "invalid", observations: [] });
    expect(parseObservationsJsonResult("[] [ { \"content\": \"keep this\", \"relevance\": \"high\" } ]").observations.map((item) => item.content)).toEqual([
      "keep this",
    ]);
    expect(parseObservationsJsonResult("```json [ { \"content\": \"fenced notes\", \"relevance\": \"high\" } ]").observations[0]?.content).toBe("fenced notes");
    expect(parseObservationsJsonResult('[ { "content": "truncated but first object is whole", "relevance": "high" }, { "content": "cut').observations[0]?.content).toBe("truncated but first object is whole");
    expect(parsed.map((item) => item.content)).toEqual([
      "User wants observational compaction",
      "Keep recent tail",
    ]);

    const folded = foldObservationalNotes([
      {
        type: "custom",
        customType: OBSERVATIONAL_NOTES_TYPE,
        data: {
          schema: 1,
          coveredThroughEntryId: "e1",
          observations: parsed,
        },
      },
      {
        type: "custom",
        customType: OBSERVATIONAL_NOTES_TYPE,
        data: {
          schema: 1,
          coveredThroughEntryId: "e2",
          observations: [{ content: "completed: added observational mode", relevance: "high" }],
        },
      },
    ]);
    expect(folded.coveredThroughEntryId).toBe("e2");
    expect(folded.observations.map((item) => item.content)).toContain("completed: added observational mode");
    expect(renderObservationalSummary(folded.observations)).toMatch(/## Observations/);
  });

  it("reads notes from the session jsonl even when memory only has the live tail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-om-"));
    const sessionPath = path.join(dir, "session.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({
        type: "custom",
        customType: OBSERVATIONAL_NOTES_TYPE,
        id: "note1",
        data: {
          schema: 1,
          coveredThroughEntryId: "old",
          observations: [
            { id: "om_file", content: "Notes lived on disk behind the compaction cut", relevance: "high", timestamp: "2026-08-31" },
          ],
        },
      }),
      JSON.stringify({ id: "tail", type: "message", message: { role: "user", content: "continue" } }),
    ].join("\n") + "\n", "utf8");
    const sources = collectObservationalNoteSources({
      sessionManager: {
        getSessionFile: () => sessionPath,
        getBranch: () => [{ id: "tail", type: "message", message: { role: "user", content: "continue" } }],
      },
      branchEntries: [{ id: "tail", type: "message", message: { role: "user", content: "continue" } }],
    });
    const folded = foldObservationalNotes(sources);
    expect(folded.observations.map((item) => item.content)).toEqual([
      "Notes lived on disk behind the compaction cut",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("captures new notes from a conversation chunk", async () => {
    const appended: any[] = [];
    const result = await captureObservationalNotes({
      entries: [
        { id: "u1", type: "message", message: { role: "user", content: "把观察记忆做成压缩选项" } },
        { id: "a1", type: "message", message: { role: "assistant", content: "会在压缩时直接装订已记下的要点。" } },
      ],
      completeText: async () => JSON.stringify([
        { content: "User asked to add observational compaction as a mode", relevance: "high" },
      ]),
      appendCustomEntry: (type, data) => appended.push({ type, data }),
    });
    expect(result?.recorded).toBe(1);
    expect(appended[0].type).toBe(OBSERVATIONAL_NOTES_TYPE);
    expect(appended[0].data.coveredThroughEntryId).toBe("a1");
    expect(observationsFromCaptureText('[{"content":"x","relevance":"low"}]')[0].content).toBe("x");
  });

  it("does not stamp the cursor when the model returns an empty array", async () => {
    const appended: any[] = [];
    const result = await captureObservationalNotes({
      entries: [
        { id: "u1", type: "message", message: { role: "user", content: "把观察记忆做成压缩选项，并且解释失败原因" } },
        { id: "a1", type: "message", message: { role: "assistant", content: "会在压缩时直接装订已记下的要点，空笔记不能把进度往前推。" } },
      ],
      completeText: async () => "[]",
      appendCustomEntry: (type, data) => appended.push({ type, data }),
    });
    expect(result).toMatchObject({ recorded: 0, skipped: "empty" });
    expect(appended).toEqual([]);
  });

  it("does not stamp the cursor when the model returns unparseable text", async () => {
    const appended: any[] = [];
    const result = await captureObservationalNotes({
      entries: [
        { id: "u1", type: "message", message: { role: "user", content: "继续推进实验" } },
        { id: "a1", type: "message", message: { role: "assistant", content: "先把空笔记问题修掉。" } },
      ],
      completeText: async () => "nothing worth storing, sorry",
      appendCustomEntry: (type, data) => appended.push({ type, data }),
    });
    expect(result).toMatchObject({ recorded: 0, skipped: "invalid" });
    expect(appended).toEqual([]);
  });
});

describe("observational capture model", () => {
  it("reads the current session model instead of a utility fallback", () => {
    expect(observationalCaptureModelRef({
      model: { id: "grok-4.6", provider: "xai-oauth" },
    })).toEqual({ id: "grok-4.6", provider: "xai-oauth" });
    expect(observationalCaptureModelRef({ model: { id: "grok-4.6" } })).toBeNull();
    expect(observationalCaptureModelRef({})).toBeNull();
  });
});
