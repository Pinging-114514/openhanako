/**
 * End-to-end guard for the thinking level that actually reaches the provider.
 *
 * Hana shows `thinkingLevels`; pi decides what it may send from
 * `thinkingLevelMap` alone (a missing xhigh/max key clamps silently). These
 * tests run the real projection and the real pi clamp so a listed level can no
 * longer degrade to `high`/`low` on the wire without a test going red.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { syncModels } from "../core/model-sync.ts";
import { ModelManager } from "../core/model-manager.ts";
import { deriveThinkingLevelMap } from "../core/session-thinking-level.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-thinking-wire-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function codexProjection(modelsJsonPath: string) {
  syncModels({
    "openai-codex-oauth": {
      base_url: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      auth_type: "oauth",
      models: ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.5"],
    },
    "xai-oauth": {
      base_url: "https://cli-chat-proxy.grok.com/v1",
      api: "openai-responses",
      auth_type: "oauth",
      models: ["grok-4.6", "grok-4.5"],
    },
  }, {
    modelsJsonPath,
    chatProjectionPlans: {
      "openai-codex-oauth": {
        sourceProviderId: "openai-codex-oauth",
        runtimeProviderId: "openai-codex",
        projection: "models-json",
        credentialSource: "auth-storage",
      },
      "xai-oauth": {
        sourceProviderId: "xai-oauth",
        runtimeProviderId: "xai-oauth",
        projection: "models-json",
        credentialSource: "auth-storage",
      },
    },
  });
  return JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")).providers;
}

function modelFor(providers: any, providerId: string, modelId: string) {
  const entry = providers[providerId].models.find((model: any) => model.id === modelId);
  expect(entry, `${providerId}/${modelId} projected`).toBeTruthy();
  return { ...entry, provider: providerId };
}

describe("deriveThinkingLevelMap", () => {
  it("adds wire keys for listed gated levels and leaves everything else alone", () => {
    expect(deriveThinkingLevelMap(["low", "medium", "high", "xhigh", "max"], { off: null, minimal: null }))
      .toEqual({ off: null, minimal: null, xhigh: "xhigh", max: "max" });
    expect(deriveThinkingLevelMap(["low", "medium", "high"], { off: null })).toEqual({ off: null });
    expect(deriveThinkingLevelMap(["low", "medium", "high", "xhigh"], null)).toEqual({ xhigh: "xhigh" });
  });

  it("respects a provider's explicit null for a level Hana lists", () => {
    expect(deriveThinkingLevelMap(["low", "high", "xhigh", "max"], { xhigh: "xhigh", max: null }))
      .toEqual({ xhigh: "xhigh", max: null });
  });

  it("returns the input map when there is no level list", () => {
    expect(deriveThinkingLevelMap(undefined, { off: null })).toEqual({ off: null });
    expect(deriveThinkingLevelMap(undefined, undefined)).toBeNull();
  });
});

describe("thinking levels reach the wire", () => {
  it("projects Codex xhigh and max so pi sends them instead of clamping to high", () => {
    const providers = codexProjection(path.join(tmpHome, "models.json"));

    for (const id of ["gpt-5.6-sol", "gpt-6-astra"]) {
      const model = modelFor(providers, "openai-codex", id);
      expect(model.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
      expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
      expect(clampThinkingLevel(model, "max")).toBe("max");
      expect(clampThinkingLevel(model, "off")).not.toBe("off");
    }

    const gpt55 = modelFor(providers, "openai-codex", "gpt-5.5");
    expect(clampThinkingLevel(gpt55, "xhigh")).toBe("xhigh");
  });

  it("projects Grok 4.6 xhigh and keeps max clamped to the model ceiling", () => {
    const providers = codexProjection(path.join(tmpHome, "models.json"));

    const grok46 = modelFor(providers, "xai-oauth", "grok-4.6");
    expect(grok46.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
    expect(clampThinkingLevel(grok46, "xhigh")).toBe("xhigh");
    expect(clampThinkingLevel(grok46, "max")).toBe("xhigh");

    const grok45 = modelFor(providers, "xai-oauth", "grok-4.5");
    expect(grok45.thinkingLevels).toEqual(["low", "medium", "high"]);
    expect(clampThinkingLevel(grok45, "xhigh")).toBe("high");
  });

  it("keeps the derived map on the model object the session hands to pi", async () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), "providers: {}\n", "utf-8");
    fs.writeFileSync(path.join(tmpHome, "auth.json"), JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 3600_000,
        accountId: "acct_test",
      },
    }), "utf-8");

    const manager = new ModelManager({ hanakoHome: tmpHome });
    await manager.init();
    await manager.refreshAvailable();

    const sol = manager.availableModels.find((model) => model.provider === "openai-codex" && model.id === "gpt-5.6-sol");
    expect(sol).toBeTruthy();
    expect(sol.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
    expect(clampThinkingLevel(sol, "max")).toBe("max");
    expect(clampThinkingLevel(sol, "xhigh")).toBe("xhigh");
  });
});
