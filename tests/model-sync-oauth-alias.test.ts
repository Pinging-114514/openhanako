import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncModels } from "../core/model-sync.ts";

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-sync-alias-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("model sync OAuth aliases", () => {
  it("does not project sdk-auth-alias providers into models.json", () => {
    const modelsJsonPath = path.join(tmpHome, "models.json");

    syncModels({
      "openai-codex-oauth": {
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
        auth_type: "oauth",
        models: [
          "gpt-5.4",
          "gpt-5.5",
          { id: "gpt-image-2", type: "image", name: "GPT Image 2" },
        ],
      },
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        auth_type: "api-key",
        api_key: "sk-test",
        models: ["gpt-5.5"],
      },
    }, {
      modelsJsonPath,
      chatProjectionMap: { "openai-codex-oauth": "sdk-auth-alias" },
    });

    const written = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(written.providers).not.toHaveProperty("openai-codex-oauth");
    expect(written.providers).toHaveProperty("openai");
  });

  it("projects Hana-owned OAuth models to the runtime alias without copying auth secrets", () => {
    const modelsJsonPath = path.join(tmpHome, "models.json");
    fs.writeFileSync(path.join(tmpHome, "auth.json"), JSON.stringify({
      "openai-codex": {
        access: "oauth-access-secret",
        refresh: "oauth-refresh-secret",
        accountId: "acct-secret",
        resourceUrl: "https://secret-resource.example",
      },
    }));

    syncModels({
      "openai-codex-oauth": {
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
        auth_type: "oauth",
        api_key: "catalog-oauth-secret",
        headers: {
          Authorization: "Bearer header-secret",
          Cookie: "session=cookie-secret",
        },
        models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
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
      },
    });

    const raw = fs.readFileSync(modelsJsonPath, "utf-8");
    const written = JSON.parse(raw);
    expect(written.providers).not.toHaveProperty("openai-codex-oauth");
    expect(written.providers["openai-codex"]).not.toHaveProperty("apiKey");
    expect(raw).not.toContain("oauth-access-secret");
    expect(raw).not.toContain("oauth-refresh-secret");
    expect(raw).not.toContain("catalog-oauth-secret");
    expect(raw).not.toContain("header-secret");
    expect(raw).not.toContain("cookie-secret");
    expect(raw).not.toContain("acct-secret");
    expect(raw).not.toContain("secret-resource.example");
    expect(written.providers["openai-codex"].api).toBe("openai-codex-responses");
    expect(written.providers["openai-codex"].models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      contextWindow: 353400,
      maxTokens: 128000,
      // xhigh and max are separate wire levels since pi 0.80.6; Hana derives the
      // map keys from the Codex thinkingLevels so both actually reach the request.
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
    });
  });

  it("projects GPT-6.1 Sol API prices without billing Codex OAuth or clobbering a saved price", () => {
    const modelsJsonPath = path.join(tmpHome, "models.json");
    syncModels({
      "openai-codex-oauth": {
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
        auth_type: "oauth",
        models: ["gpt-6.1-sol"],
      },
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-responses",
        auth_type: "api-key",
        api_key: "sk-test",
        models: ["gpt-6.1-sol"],
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
        openai: {
          sourceProviderId: "openai",
          runtimeProviderId: "openai",
          projection: "models-json",
          credentialSource: "provider-catalog",
        },
      },
    });

    const written = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(written.providers["openai-codex"].models[0]).toMatchObject({
      id: "gpt-6.1-sol",
      api: "openai-codex-responses",
      contextWindow: 272000,
      maxTokens: 128000,
      defaultThinkingLevel: "low",
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
    });
    expect(written.providers["openai-codex"].models[0]).not.toHaveProperty("cost");
    expect(written.providers["openai-codex"].models[0].contextWindow).not.toBe(1050000);
    expect(written.providers.openai.models[0]).toMatchObject({
      id: "gpt-6.1-sol",
      api: "openai-responses",
      contextWindow: 1050000,
      maxTokens: 128000,
      defaultThinkingLevel: "medium",
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    });
    syncModels({
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-responses",
        auth_type: "api-key",
        api_key: "sk-test",
        models: [{
          id: "gpt-6.1-sol",
          context: 200000,
          cost: { input: 9, output: 9, cacheRead: 1, cacheWrite: 1 },
        }],
      },
    }, {
      modelsJsonPath,
      chatProjectionPlans: {
        openai: {
          sourceProviderId: "openai",
          runtimeProviderId: "openai",
          projection: "models-json",
          credentialSource: "provider-catalog",
        },
      },
    });
    const custom = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(custom.providers.openai.models[0]).toMatchObject({
      id: "gpt-6.1-sol",
      contextWindow: 200000,
      cost: { input: 9, output: 9, cacheRead: 1, cacheWrite: 1 },
    });
    syncModels({
      "openai-codex-oauth": {
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
        auth_type: "oauth",
        models: [{
          id: "gpt-6.1-sol",
          cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
        }],
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
      },
    });
    const oauthCustom = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(oauthCustom.providers["openai-codex"].models[0]).toMatchObject({
      id: "gpt-6.1-sol",
      contextWindow: 272000,
      cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
    });
    expect(oauthCustom.providers["openai-codex"].models[0].cost).not.toMatchObject({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
  });

  it("rejects an unknown credential source before changing models.json", () => {
    const modelsJsonPath = path.join(tmpHome, "models.json");
    const original = JSON.stringify({ providers: { preserved: { apiKey: "keep-me" } } }, null, 2) + "\n";
    fs.writeFileSync(modelsJsonPath, original, "utf-8");

    expect(() => syncModels({
      "typo-oauth": {
        base_url: "https://oauth.example/v1",
        api: "openai-responses",
        auth_type: "oauth",
        api_key: "stale-catalog-token",
        headers: { Authorization: "Bearer stale-header" },
        models: ["typo-model"],
      },
    }, {
      modelsJsonPath,
      chatProjectionPlans: {
        "typo-oauth": {
          sourceProviderId: "typo-oauth",
          runtimeProviderId: "typo-runtime",
          projection: "models-json",
          credentialSource: "auth-stroage",
        },
      },
    })).toThrow(/Invalid chat credentialSource.*auth-stroage/i);

    expect(fs.readFileSync(modelsJsonPath, "utf-8")).toBe(original);
  });
});
