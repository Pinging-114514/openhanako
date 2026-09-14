import { describe, expect, it } from "vitest";
import { getProviderPromptPatches } from "../core/provider-prompt-patches.ts";

describe("provider prompt patches — DeepSeek output contract", () => {
  it("adds the DeepSeek patch for official DeepSeek reasoning models", () => {
    const patches = getProviderPromptPatches({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      reasoning: true,
    }, { reasoningLevel: "high", locale: "zh-CN" });

    expect(patches.join("\n")).toContain("如果你使用的是 DeepSeek 模型");
    expect(patches.join("\n")).toContain("DeepSeek 输出契约");
  });

  it("adds the DeepSeek patch for DeepSeek family models hosted by other providers", () => {
    const patches = getProviderPromptPatches({
      id: "deepseek/deepseek-v4-pro",
      provider: "openrouter",
      reasoning: true,
    }, { reasoningLevel: "high", locale: "zh-CN" });

    expect(patches.join("\n")).toContain("DeepSeek 输出契约");
  });

  it("adds the DeepSeek patch for deepseek-ai model ids even when provider is not DeepSeek", () => {
    const patches = getProviderPromptPatches({
      id: "deepseek-ai/DeepSeek-R1",
      provider: "siliconflow",
      reasoning: true,
    }, { reasoningLevel: "medium", locale: "zh-CN" });

    expect(patches.join("\n")).toContain("DeepSeek 输出契约");
  });

  it("does not add the patch when thinking is off", () => {
    const patches = getProviderPromptPatches({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      reasoning: true,
    }, { reasoningLevel: "off", locale: "zh-CN" });

    expect(patches).toEqual([]);
  });

  it("does not add the patch for non-DeepSeek reasoning models", () => {
    const patches = getProviderPromptPatches({
      id: "kimi-k2.6",
      provider: "kimi-coding",
      reasoning: true,
      compat: { thinkingFormat: "anthropic" },
    }, { reasoningLevel: "high", locale: "zh-CN" });

    expect(patches).toEqual([]);
  });

  it("does not include the removed restatement sentence", () => {
    const patches = getProviderPromptPatches({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      reasoning: true,
    }, { reasoningLevel: "high", locale: "zh-CN" });

    expect(patches.join("\n")).not.toContain("如果你已经在 reasoning_content / thinking 中写出了可展示内容");
  });
});

describe("provider prompt patches — GPT-6 behaviour calibration", () => {
  it("adds the GPT-6 patch for Astra through Codex OAuth, in the session locale", () => {
    const zh = getProviderPromptPatches({
      id: "gpt-6-astra",
      provider: "openai-codex",
      api: "openai-codex-responses",
      reasoning: true,
    }, { reasoningLevel: "medium", locale: "zh-CN" });
    expect(zh).toHaveLength(1);
    expect(zh[0]).toContain("你是 GPT-6 系列模型");
    expect(zh[0]).toContain("倾向于行动");
    expect(zh[0]).toContain("不要因为假设性风险主动加免责声明");

    const en = getProviderPromptPatches({
      id: "gpt-6-astra",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
    }, { reasoningLevel: "high", locale: "en" });
    expect(en).toHaveLength(1);
    expect(en[0]).toContain("bias towards action");
    expect(en[0]).toContain("do not write tests for reversible, low-impact edits");
  });

  it("keeps the GPT-6 patch when thinking is off and stays out of other OpenAI models", () => {
    expect(getProviderPromptPatches({
      id: "gpt-6-astra",
      provider: "openai-codex",
      reasoning: true,
    }, { reasoningLevel: "off", locale: "en" })).toHaveLength(1);

    expect(getProviderPromptPatches({
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoning: true,
    }, { reasoningLevel: "high", locale: "en" })).toEqual([]);
  });
});
