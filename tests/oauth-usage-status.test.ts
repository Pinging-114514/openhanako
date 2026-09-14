import { describe, expect, it } from "vitest";
import {
  classifyOauthUsageHttpError,
  inferOauthAuthErrorCode,
  mergeOauthUsageSnapshot,
  publicOauthUsage,
} from "../shared/oauth-usage.ts";

describe("classifyOauthUsageHttpError", () => {
  it("treats chatgpt token_revoked as auth_revoked", () => {
    expect(classifyOauthUsageHttpError(401, JSON.stringify({
      error: {
        message: "Encountered invalidated oauth token for user, failing request",
        code: "token_revoked",
      },
    }))).toBe("auth_revoked");
  });

  it("treats 401/403 without a body as auth_revoked", () => {
    expect(classifyOauthUsageHttpError(401, "")).toBe("auth_revoked");
    expect(classifyOauthUsageHttpError(403, "forbidden")).toBe("auth_revoked");
  });

  it("keeps 429 and 5xx distinct from a dead account", () => {
    expect(classifyOauthUsageHttpError(429, "too many")).toBe("rate_limited");
    expect(classifyOauthUsageHttpError(500, "boom")).toBe("upstream");
  });
});

describe("inferOauthAuthErrorCode", () => {
  it("reads the raw chatgpt sentence that chat currently dumps", () => {
    expect(inferOauthAuthErrorCode(
      "Encountered invalidated oauth token for user, failing request",
    )).toBe("token_revoked");
    expect(inferOauthAuthErrorCode("Your session has ended. Please log in again.")).toBe("token_revoked");
    expect(inferOauthAuthErrorCode("rate limited")).toBeNull();
  });
});

describe("mergeOauthUsageSnapshot", () => {
  const good = {
    ok: true,
    remaining: 81,
    resetAt: "2026-08-23T04:00:00.000Z",
    planType: null,
    windowKind: "week" as const,
    windowSeconds: null,
    error: null,
    stale: false,
  };

  it("keeps the last remaining percent on a network blip", () => {
    expect(mergeOauthUsageSnapshot(good, {
      ok: false,
      error: "network",
      remaining: null,
    })).toMatchObject({
      ok: false,
      remaining: 81,
      error: "network",
      stale: true,
    });
  });

  it("does not keep a leftover percent when the account is dead", () => {
    expect(mergeOauthUsageSnapshot(good, {
      ok: false,
      error: "auth_revoked",
      remaining: null,
    })).toMatchObject({
      ok: false,
      remaining: null,
      error: "auth_revoked",
      stale: false,
    });
  });
});

describe("publicOauthUsage", () => {
  it("exposes error instead of collapsing every failure to ok:false", () => {
    expect(publicOauthUsage({
      ok: false,
      error: "auth_revoked",
      remaining: null,
    })).toMatchObject({
      ok: false,
      error: "auth_revoked",
    });
  });
});
