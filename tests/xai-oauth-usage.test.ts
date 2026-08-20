import { describe, expect, it, vi } from "vitest";
import { fetchXaiOauthUsage, summarizeXaiOauthUsage } from "../lib/auth/xai-oauth-usage.ts";

describe("summarizeXaiOauthUsage", () => {
  it("reads weekly remaining from creditUsagePercent", () => {
    expect(summarizeXaiOauthUsage({
      config: {
        creditUsagePercent: 35.4,
        currentPeriod: { end: "2026-08-23T04:13:07.884Z" },
      },
    })).toEqual({
      ok: true,
      used: 35,
      remaining: 65,
      resetAt: "2026-08-23T04:13:07.884Z",
    });
  });
});

describe("fetchXaiOauthUsage", () => {
  it("returns not_logged_in without a token", async () => {
    await expect(fetchXaiOauthUsage({ accessToken: "" })).resolves.toMatchObject({
      ok: false,
      error: "not_logged_in",
    });
  });

  it("calls grok billing with the oauth access token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      config: { creditUsagePercent: 20, currentPeriod: { end: "2026-08-23T04:00:00.000Z" } },
    }), { status: 200 }));
    const result = await fetchXaiOauthUsage({
      accessToken: "grok-access",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer grok-access",
          "x-xai-token-auth": "xai-grok-cli",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, used: 20, remaining: 80 });
  });
});
