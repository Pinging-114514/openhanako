import { afterEach, describe, expect, it, vi } from "vitest";
import { startOauthUsageRefreshLoop } from "../lib/auth/oauth-usage-refresh-loop.ts";

const refreshOauthAccountUsages = vi.fn(async () => {});

vi.mock("../lib/auth/oauth-account-vault.ts", () => ({
  refreshOauthAccountUsages: (...args: unknown[]) => refreshOauthAccountUsages(...args),
}));

describe("oauth usage refresh loop", () => {
  afterEach(() => {
    vi.useRealTimers();
    refreshOauthAccountUsages.mockReset();
  });

  it("refreshes Codex and Grok after the start delay, then on the interval", async () => {
    vi.useFakeTimers();
    const engine = { hanakoHome: "/tmp/hana-oauth-loop" };
    const stop = startOauthUsageRefreshLoop(engine, { startDelayMs: 20_000, intervalMs: 60_000 });

    expect(refreshOauthAccountUsages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshOauthAccountUsages.mock.calls.map((call) => call[1])).toEqual([
      "openai-codex",
      "xai-oauth",
    ]);

    refreshOauthAccountUsages.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshOauthAccountUsages.mock.calls.map((call) => call[1])).toEqual([
      "openai-codex",
      "xai-oauth",
    ]);

    stop();
    refreshOauthAccountUsages.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshOauthAccountUsages).not.toHaveBeenCalled();
  });
});
