import { describe, expect, it } from "vitest";
import {
  inspectOauthCredential,
  looksLikeOpaqueId,
  normalizeMultiOauthAuthKey,
  resolveOauthAccountLabels,
} from "../lib/auth/oauth-account-identity.ts";

function jwtWith(payload: Record<string, unknown>): string {
  return `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

describe("normalizeMultiOauthAuthKey", () => {
  it("maps Codex aliases and leaves other providers out", () => {
    expect(normalizeMultiOauthAuthKey("openai-codex-oauth")).toBe("openai-codex");
    expect(normalizeMultiOauthAuthKey("openai-codex")).toBe("openai-codex");
    expect(normalizeMultiOauthAuthKey("xai-oauth")).toBe("xai-oauth");
    expect(normalizeMultiOauthAuthKey("anthropic")).toBeNull();
  });
});

describe("inspectOauthCredential", () => {
  it("reads Codex account id and email from the access token", () => {
    const identity = inspectOauthCredential({
      type: "oauth",
      access: jwtWith({
        email: "work@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-work-123456" },
      }),
      refresh: "refresh-work",
    }, "openai-codex");

    expect(identity).toMatchObject({
      accountId: "acct-work-123456",
      email: "work@example.com",
      displayName: "work@example.com",
      shortLabel: "work",
      matchKey: "acct-work-123456",
    });
  });

  it("falls back to Grok email and a token tail when the JWT has no account id", () => {
    const identity = inspectOauthCredential({
      type: "oauth",
      access: jwtWith({ email: "grok.user@x.ai" }),
      refresh: "refresh-token-tail-xyz",
    }, "xai-oauth");

    expect(identity).toMatchObject({
      email: "grok.user@x.ai",
      displayName: "grok.user@x.ai",
      shortLabel: "grok.user",
      matchKey: "grok.user@x.ai",
    });
  });

  it("reads Codex email from the OpenAI profile claim, not the ChatGPT account id", () => {
    const identity = inspectOauthCredential({
      type: "oauth",
      access: jwtWith({
        "https://api.openai.com/auth": { chatgpt_account_id: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" },
        "https://api.openai.com/profile": { email: "plus@example.com", name: "Plus User" },
      }),
      refresh: "refresh-codex",
    }, "openai-codex");

    expect(identity).toMatchObject({
      email: "plus@example.com",
      displayName: "plus@example.com",
      shortLabel: "plus",
      accountId: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e",
    });
  });

  it("reads Grok email from the id token when the access token has none", () => {
    const identity = inspectOauthCredential({
      type: "oauth",
      access: jwtWith({ sub: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" }),
      idToken: jwtWith({ email: "grok.id@x.ai", name: "Grok Id" }),
      refresh: "refresh-grok",
    }, "xai-oauth");

    expect(identity).toMatchObject({
      email: "grok.id@x.ai",
      displayName: "grok.id@x.ai",
      shortLabel: "grok.id",
    });
  });

  it("does not use a Grok subject UUID as the visible label", () => {
    const identity = inspectOauthCredential({
      type: "oauth",
      access: jwtWith({ sub: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" }),
      refresh: "refresh-grok",
    }, "xai-oauth");

    expect(identity?.email).toBe("");
    expect(identity?.displayName).toBe("Grok");
    expect(identity?.shortLabel).toBe("Grok");
    expect(identity?.accountId).toBe("8fcc46b9-2ef3-4ab2-8c24-1414b32b138e");
  });
});

describe("resolveOauthAccountLabels", () => {
  it("keeps an email and drops a leftover UUID display name", () => {
    expect(resolveOauthAccountLabels({
      email: "saved@example.com",
      displayName: "b32b138e",
    }, "xai-oauth")).toEqual({
      email: "saved@example.com",
      displayName: "saved@example.com",
      shortLabel: "saved",
    });
  });

  it("falls back to the provider name when nothing readable exists", () => {
    expect(resolveOauthAccountLabels({
      email: "",
      displayName: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e",
    }, "xai-oauth")).toEqual({
      email: "",
      displayName: "Grok",
      shortLabel: "Grok",
    });
  });
});

describe("looksLikeOpaqueId", () => {
  it("treats UUIDs and short hex tails as unreadable", () => {
    expect(looksLikeOpaqueId("8fcc46b9-2ef3-4ab2-8c24-1414b32b138e")).toBe(true);
    expect(looksLikeOpaqueId("b32b138e")).toBe(true);
    expect(looksLikeOpaqueId("user@example.com")).toBe(false);
    expect(looksLikeOpaqueId("Grok")).toBe(false);
  });
});
