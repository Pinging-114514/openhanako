import { describe, expect, it, vi } from "vitest";
import {
  fetchCodexOauthUsage,
  publicCodexOauthUsage,
  readCodexOauthUsageCached,
  refreshCodexOauthUsageCache,
  summarizeCodexOauthUsage,
} from "../lib/auth/openai-codex-oauth-usage.ts";

describe("summarizeCodexOauthUsage", () => {
  it("reads weekly remaining from the primary window", () => {
    expect(summarizeCodexOauthUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 3,
          limit_window_seconds: 604800,
          reset_at: 1787801632,
        },
      },
    })).toEqual({
      ok: true,
      planType: "pro",
      used: 3,
      remaining: 97,
      windowSeconds: 604800,
      windowKind: "week",
      resetAt: "2026-08-27T03:33:52.000Z",
      error: null,
      stale: false,
    });
  });

  it("labels a 5-hour primary window as hours", () => {
    const summary = summarizeCodexOauthUsage({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 40.4,
          limit_window_seconds: 18000,
          reset_after_seconds: 3600,
        },
      },
    });
    expect(summary).toMatchObject({
      ok: true,
      planType: "plus",
      used: 40,
      remaining: 60,
      windowSeconds: 18000,
      windowKind: "hours",
    });
    expect(summary.resetAt).toEqual(expect.any(String));
  });
});

describe("fetchCodexOauthUsage", () => {
  it("returns not_logged_in without a token", async () => {
    await expect(fetchCodexOauthUsage({ accessToken: "" })).resolves.toMatchObject({
      ok: false,
      error: "not_logged_in",
    });
  });

  it("calls chatgpt wham usage with bearer and account headers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 3,
          limit_window_seconds: 604800,
          reset_at: 1787801632,
        },
      },
    }), { status: 200 }));
    const result = await fetchCodexOauthUsage({
      accessToken: "codex-access",
      accountId: "acct-1",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer codex-access",
          "chatgpt-account-id": "acct-1",
          "ChatGPT-Account-ID": "acct-1",
          originator: "pi",
          "Content-Type": "application/json",
          "OpenAI-Beta": "responses=experimental",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, remaining: 97, planType: "pro" });
  });

  it("classifies chatgpt 401 as auth_revoked", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: "Encountered invalidated oauth token for user, failing request",
        code: "token_revoked",
      },
      status: 401,
    }), { status: 401 }));
    await expect(fetchCodexOauthUsage({
      accessToken: "codex-access",
      fetchImpl,
    })).resolves.toMatchObject({
      ok: false,
      error: "auth_revoked",
      remaining: null,
    });
  });
});

describe("codex oauth usage cache", () => {
  it("stores the startup fetch on the engine", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 3,
          limit_window_seconds: 604800,
          reset_at: 1787801632,
        },
      },
    }), { status: 200 }));
    const engine = {
      authStorage: {
        get: () => ({ type: "oauth", access: "codex-access", accountId: "acct-1" }),
      },
    };
    await refreshCodexOauthUsageCache(engine, { fetchImpl });
    expect(engine.codexOauthUsage).toMatchObject({ ok: true, remaining: 97, planType: "pro" });
    expect(publicCodexOauthUsage(engine.codexOauthUsage)).toMatchObject({
      ok: true,
      remaining: 97,
      planType: "pro",
      windowKind: "week",
      error: null,
      stale: false,
    });
  });

  it("keeps the last remaining percent when a later refresh fails on the network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const engine = {
      authStorage: {
        get: () => ({ type: "oauth", access: "codex-access", accountId: "acct-1" }),
      },
      codexOauthUsage: {
        ok: true,
        remaining: 80,
        planType: "plus",
        windowKind: "week",
        resetAt: null,
        used: 20,
        windowSeconds: 604800,
      },
    };
    await refreshCodexOauthUsageCache(engine, { fetchImpl });
    expect(engine.codexOauthUsage).toMatchObject({
      ok: false,
      remaining: 80,
      error: "network",
      stale: true,
    });
  });

  it("returns the cached snapshot without hitting chatgpt again", async () => {
    const fetchImpl = vi.fn();
    const cached = { ok: true, remaining: 80, planType: "plus", windowKind: "week", resetAt: null, used: 20, windowSeconds: 604800 };
    const engine = { codexOauthUsage: cached };
    await expect(readCodexOauthUsageCached(engine, { fetchImpl })).resolves.toBe(cached);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
