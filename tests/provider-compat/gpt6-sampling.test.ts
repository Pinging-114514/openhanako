import { describe, expect, it } from "vitest";
import { normalizeProviderPayload } from "../../core/provider-compat.ts";
import { isGpt6Model, stripGpt6SamplingParameters } from "../../core/provider-compat/gpt6-sampling.ts";

describe("GPT-6 sampling parameter cleanup", () => {
  it("recognizes the GPT-6 family by model id or payload model, including relay prefixes", () => {
    expect(isGpt6Model({ id: "gpt-6-astra" })).toBe(true);
    expect(isGpt6Model({ id: "openai/gpt-6-astra" })).toBe(true);
    expect(isGpt6Model(null, { model: "gpt-6" })).toBe(true);
    expect(isGpt6Model({ id: "gpt-5.6-sol" })).toBe(false);
    expect(isGpt6Model({ id: "gpt-60-preview" })).toBe(false);
  });

  it("drops temperature, top_p and logprob controls for GPT-6 on any OpenAI surface", () => {
    const payload = {
      model: "gpt-6-astra",
      temperature: 0.3,
      top_p: 0.9,
      top_logprobs: 3,
      logprobs: true,
      include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
      input: [{ role: "user", content: "hi" }],
    };
    const result = stripGpt6SamplingParameters(payload, { id: "gpt-6-astra", api: "openai-responses" });
    expect(result).not.toHaveProperty("temperature");
    expect(result).not.toHaveProperty("top_p");
    expect(result).not.toHaveProperty("top_logprobs");
    expect(result).not.toHaveProperty("logprobs");
    expect(result.include).toEqual(["reasoning.encrypted_content"]);
    expect(result.input).toBe(payload.input);
    expect(payload.temperature).toBe(0.3);
  });

  it("leaves other models and clean payloads untouched", () => {
    const sol = { model: "gpt-5.6-sol", temperature: 0.7, input: [] };
    expect(stripGpt6SamplingParameters(sol, { id: "gpt-5.6-sol" })).toBe(sol);
    const clean = { model: "gpt-6-astra", input: [] };
    expect(stripGpt6SamplingParameters(clean, { id: "gpt-6-astra" })).toBe(clean);
  });

  it("applies through normalizeProviderPayload for a relayed openai-responses utility call", () => {
    const model = {
      id: "gpt-6-astra",
      provider: "anyrouter",
      api: "openai-responses",
      baseUrl: "https://relay.example/v1",
      reasoning: true,
    };
    const result = normalizeProviderPayload({
      model: "gpt-6-astra",
      temperature: 0.2,
      instructions: "summarize",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    }, model, { mode: "utility" });
    expect(result).not.toHaveProperty("temperature");
    expect(result.instructions).toBe("summarize");
  });
});
