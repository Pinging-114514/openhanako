import { describe, expect, it, vi } from "vitest";
import {
  fetchCodexOauthUsage,
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
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, remaining: 97, planType: "pro" });
  });
});
