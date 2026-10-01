import { describe, expect, it, vi } from "vitest";
import {
  fetchXaiOauthPlanType,
  fetchXaiOauthUsage,
  fetchXaiOauthUserinfo,
  normalizeXaiOauthPlanType,
  parseXaiOauthPlanType,
  publicXaiOauthUsage,
  readXaiOauthUsageCached,
  refreshXaiOauthUsageCache,
  summarizeXaiOauthUsage,
} from "../lib/auth/xai-oauth-usage.ts";

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
      planType: null,
      error: null,
      stale: false,
    });
  });

  it("reads SuperGrok Heavy from the billing envelope when settings are absent", () => {
    expect(summarizeXaiOauthUsage({
      subscription_tier: "SuperGrok Heavy",
      config: { creditUsagePercent: 20, currentPeriod: { end: "2026-08-23T04:00:00.000Z" } },
    })).toMatchObject({ ok: true, remaining: 80, planType: "heavy" });
  });
});

describe("normalizeXaiOauthPlanType", () => {
  it("shortens SuperGrok labels the way Codex shortens pro", () => {
    expect(normalizeXaiOauthPlanType("SuperGrok Heavy")).toBe("heavy");
    expect(normalizeXaiOauthPlanType("heavy")).toBe("heavy");
    expect(normalizeXaiOauthPlanType("SuperGrok")).toBe("super");
    expect(normalizeXaiOauthPlanType("super")).toBe("super");
    expect(parseXaiOauthPlanType({ subscription_tier_display: "SuperGrok Heavy" })).toBe("heavy");
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
          "x-grok-client-version": "1.0.13",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, used: 20, remaining: 80 });
  });

  it("reads SuperGrok Heavy from /v1/settings", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/settings")) {
        return new Response(JSON.stringify({ subscription_tier_display: "SuperGrok Heavy" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        config: { creditUsagePercent: 70, currentPeriod: { end: "2026-08-23T04:00:00.000Z" } },
      }), { status: 200 });
    });
    await expect(fetchXaiOauthUsage({
      accessToken: "grok-access",
      fetchImpl,
    })).resolves.toMatchObject({ ok: true, remaining: 30, planType: "heavy" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/settings",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads SuperGrok as super when settings only have that tier", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/settings")) {
        return new Response(JSON.stringify({ subscription_tier_display: "SuperGrok" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        config: { creditUsagePercent: 10, currentPeriod: { end: "2026-08-23T04:00:00.000Z" } },
      }), { status: 200 });
    });
    await expect(fetchXaiOauthUsage({
      accessToken: "grok-access",
      fetchImpl,
    })).resolves.toMatchObject({ ok: true, remaining: 90, planType: "super" });
  });

  it("keeps quota when settings are missing", async () => {
    await expect(fetchXaiOauthPlanType({
      accessToken: "grok-access",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })),
    })).resolves.toBeNull();
  });

  it("classifies grok 401 as auth_revoked", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    await expect(fetchXaiOauthUsage({
      accessToken: "grok-access",
      fetchImpl,
    })).resolves.toMatchObject({
      ok: false,
      error: "auth_revoked",
    });
  });
});

describe("fetchXaiOauthUserinfo", () => {
  it("reads email from the xAI userinfo endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      email: "grok.user@x.ai",
      name: "Grok User",
    }), { status: 200 }));
    await expect(fetchXaiOauthUserinfo({
      accessToken: "grok-access",
      fetchImpl,
    })).resolves.toEqual({
      email: "grok.user@x.ai",
      name: "Grok User",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/userinfo",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer grok-access",
        }),
      }),
    );
  });

  it("returns empty fields when userinfo is missing or fails", async () => {
    await expect(fetchXaiOauthUserinfo({ accessToken: "" })).resolves.toEqual({
      email: "",
      name: "",
    });
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(fetchXaiOauthUserinfo({
      accessToken: "grok-access",
      fetchImpl,
    })).resolves.toEqual({ email: "", name: "" });
  });
});

describe("xai oauth usage cache", () => {
  it("stores the startup fetch on the engine", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      config: { creditUsagePercent: 20, currentPeriod: { end: "2026-08-23T04:00:00.000Z" } },
    }), { status: 200 }));
    const engine = {
      authStorage: {
        get: () => ({ type: "oauth", access: "grok-access" }),
      },
    };
    await refreshXaiOauthUsageCache(engine, { fetchImpl });
    expect(engine.xaiOauthUsage).toMatchObject({ ok: true, remaining: 80 });
    expect(publicXaiOauthUsage(engine.xaiOauthUsage)).toMatchObject({
      ok: true,
      remaining: 80,
      resetAt: "2026-08-23T04:00:00.000Z",
    });
  });

  it("returns the cached snapshot without hitting grok again", async () => {
    const fetchImpl = vi.fn();
    const cached = { ok: true, remaining: 80, used: 20, resetAt: "2026-08-23T04:00:00.000Z" };
    const engine = { xaiOauthUsage: cached };
    await expect(readXaiOauthUsageCached(engine, { fetchImpl })).resolves.toBe(cached);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
