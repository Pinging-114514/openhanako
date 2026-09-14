import { describe, expect, it } from "vitest";
import { publicAvailableModel, publicUtilityRoles, resolveSampleTextModelRef, resolveSampleTextUtilityRole } from "../core/plugin-sample-text.ts";

describe("plugin sample-text helpers", () => {
  it("treats missing or utility reviewers as the host utility path", () => {
    expect(resolveSampleTextModelRef({})).toBeNull();
    expect(resolveSampleTextModelRef({ model: "utility" })).toBeNull();
    expect(resolveSampleTextModelRef({ model: "utility_large" })).toBeNull();
    expect(resolveSampleTextModelRef({ modelKey: "" })).toBeNull();
    expect(resolveSampleTextUtilityRole({})).toBe("utility");
    expect(resolveSampleTextUtilityRole({ model: "utility" })).toBe("utility");
    expect(resolveSampleTextUtilityRole({ modelKey: "utility_large" })).toBe("utility_large");
  });

  it("requires a provider/id pair", () => {
    expect(resolveSampleTextModelRef({ model: "xai-oauth/grok-4.6" })).toEqual({
      provider: "xai-oauth",
      id: "grok-4.6",
    });
    expect(() => resolveSampleTextModelRef({ model: "grok-4.6" })).toThrow(/provider/);
  });

  it("serializes a picker row without credentials", () => {
    expect(publicAvailableModel({
      id: "grok-4.6",
      provider: "xai-oauth",
      name: "Grok 4.6",
      thinkingLevels: ["low", "high", "xhigh"],
    })).toMatchObject({
      key: "xai-oauth/grok-4.6",
      name: "Grok 4.6",
      thinkingLevels: ["low", "high", "xhigh"],
    });
  });

  it("labels utility roles with the live model name and its thinking levels", () => {
    const roles = publicUtilityRoles({
      utility_large: { id: "gpt-6-astra", provider: "openai-codex-oauth" },
    }, [{
      id: "gpt-6-astra",
      provider: "openai-codex-oauth",
      name: "GPT-6 Astra",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultThinkingLevel: "medium",
    }]);

    expect(roles.utility).toMatchObject({
      key: "utility",
      name: "小工具模型",
      currentName: null,
    });
    expect(roles.utility_large).toMatchObject({
      key: "utility_large",
      name: "大工具模型 · GPT-6 Astra",
      currentName: "GPT-6 Astra",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultThinkingLevel: "medium",
    });
  });
});
