import { describe, expect, it } from "vitest";
import { lookupReferenceMetadata } from "../shared/model-reference-lookup.ts";

describe("lookupReferenceMetadata", () => {
  const dict = {
    openai: {
      "gpt-6-astra": { thinkingLevels: ["low", "high"], api: "openai-responses" },
    },
    other: {
      "gpt-6-astra": { thinkingLevels: ["max"] },
    },
  };
  const fallbacks = {
    "known-fallback": { thinkingLevels: ["medium"] },
  };

  it("prefers the provider section, then the fallback, then another provider", () => {
    expect(lookupReferenceMetadata(dict, fallbacks, "openai", "gpt-6-astra")?.thinkingLevels).toEqual(["low", "high"]);
    expect(lookupReferenceMetadata(dict, fallbacks, "relay", "known-fallback")?.thinkingLevels).toEqual(["medium"]);
    expect(lookupReferenceMetadata(dict, fallbacks, "relay", "gpt-6-astra")?.thinkingLevels).toEqual(["low", "high"]);
    expect(lookupReferenceMetadata({
      "openai-codex-oauth": { "gpt-5.6-sol": { context: 353400 } },
      openai: { "gpt-5.6-sol": { context: 1050000 } },
    }, {}, "openai-codex", "gpt-5.6-sol")?.context).toBe(353400);
  });
});
