import { describe, expect, it } from "vitest";

import { normalizeProviderPayload } from "../../core/provider-compat.ts";
import * as codexResponses from "../../core/provider-compat/codex-responses.ts";

const CODEX_MODEL = {
  id: "gpt-5.5",
  provider: "openai-codex-oauth",
  api: "openai-codex-responses",
};

describe("provider-compat/codex-responses", () => {
  it("matches only Codex Responses API models", () => {
    expect(codexResponses.matches(null)).toBe(false);
    expect(codexResponses.matches(CODEX_MODEL)).toBe(true);
    expect(codexResponses.matches({
      id: "gpt-5.5",
      provider: "openai-codex",
      api: "openai-codex-responses",
    })).toBe(true);
    expect(codexResponses.matches({
      id: "gpt-5.5",
      provider: "openai-codex-oauth",
      api: "openai-responses",
    })).toBe(false);
    expect(codexResponses.matches({
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-codex-responses",
    })).toBe(false);
  });

  it("strips unsupported Codex Responses request fields without mutating payload", () => {
    const payload = {
      model: "gpt-5.5",
      store: false,
      stream: true,
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 1000,
      max_completion_tokens: 1000,
      max_tokens: 1000,
      maxOutputTokens: 1000,
      temperature: 0,
    };

    const result = normalizeProviderPayload(payload, CODEX_MODEL, { mode: "utility" });

    expect(result).not.toBe(payload);
    expect(result).toMatchObject({
      model: "gpt-5.5",
      store: false,
      stream: true,
      input: [{ role: "user", content: "hi" }],
    });
    expect(result).not.toHaveProperty("max_output_tokens");
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(result).not.toHaveProperty("max_tokens");
    expect(result).not.toHaveProperty("maxOutputTokens");
    expect(result).not.toHaveProperty("temperature");
    expect(payload).toHaveProperty("max_output_tokens", 1000);
    expect(payload).toHaveProperty("temperature", 0);
  });

  it("does not strip the same fields for non-Codex providers", () => {
    const payload = {
      model: "gpt-5",
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 1000,
      max_completion_tokens: 1000,
      max_tokens: 1000,
      maxOutputTokens: 1000,
      temperature: 0,
    };

    const result = normalizeProviderPayload(payload, {
      id: "gpt-5",
      provider: "openai",
      api: "openai-responses",
    }, { mode: "utility" });

    expect(result).toBe(payload);
    expect(result).toMatchObject({
      max_output_tokens: 1000,
      max_completion_tokens: 1000,
      max_tokens: 1000,
      maxOutputTokens: 1000,
      temperature: 0,
    });
  });
});

describe("provider-compat/codex-responses speed tier", () => {
  const base = { model: "gpt-6-astra", store: false, stream: true, input: [] };

  it("writes the Codex wire value for the chosen tier through normalizeProviderPayload", () => {
    const fast = normalizeProviderPayload(base, CODEX_MODEL, { mode: "chat", codexServiceTier: "fast" });
    expect(fast.service_tier).toBe("priority");
    const ultrafast = normalizeProviderPayload(base, { ...CODEX_MODEL, id: "gpt-6-astra" }, {
      mode: "chat", codexServiceTier: "ultrafast", codexUltrafastEligible: true,
    });
    expect(ultrafast.service_tier).toBe("ultrafast");
  });

  it.each(["chat", "utility"])("downgrades inherited and selected ultrafast without verified entitlement in %s", mode => {
    const astra = { ...CODEX_MODEL, id: "gpt-6-astra" };
    expect(normalizeProviderPayload(base, astra, { mode, codexServiceTier: "ultrafast" }).service_tier).toBe("priority");
    expect(normalizeProviderPayload({ ...base, service_tier: "ultrafast" }, astra, { mode }).service_tier).toBe("priority");
    expect(normalizeProviderPayload({ ...base, model: "gpt-6.1-sol" }, { ...CODEX_MODEL, id: "gpt-6.1-sol" }, {
      mode, codexServiceTier: "ultrafast", codexUltrafastEligible: true,
    }).service_tier).toBe("priority");
  });

  it("does not let stale Astra metadata enable ultrafast for a Sol wire model", () => {
    expect(normalizeProviderPayload({ ...base, model: "gpt-6.1-sol" }, { ...CODEX_MODEL, id: "gpt-6-astra" }, {
      mode: "chat", codexServiceTier: "ultrafast", codexUltrafastEligible: true,
    }).service_tier).toBe("priority");
  });

  it("removes service_tier for the standard tier and when the tier is unknown", () => {
    const carried = { ...base, service_tier: "priority" };
    expect(normalizeProviderPayload(carried, CODEX_MODEL, { mode: "chat", codexServiceTier: "standard" })).not.toHaveProperty("service_tier");
    expect(normalizeProviderPayload(carried, CODEX_MODEL, { mode: "chat", codexServiceTier: "bogus" })).not.toHaveProperty("service_tier");
  });

  it("leaves service_tier alone when the caller states no tier and never touches non-Codex models", () => {
    const carried = { ...base, service_tier: "priority" };
    expect(normalizeProviderPayload(carried, CODEX_MODEL, { mode: "chat" }).service_tier).toBe("priority");
    const openai = { id: "gpt-6-astra", provider: "openai", api: "openai-responses" };
    expect(normalizeProviderPayload(base, openai, { mode: "chat", codexServiceTier: "fast" })).not.toHaveProperty("service_tier");
  });
});