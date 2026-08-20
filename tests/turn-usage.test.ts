import { describe, expect, it } from "vitest";
import {
  assignTurnUsageToAssistants,
  compactTokenCount,
  formatTurnUsageSpeed,
  summarizeTurnUsage,
  turnUsageFromPiAssistantUsage,
} from "../lib/llm/turn-usage.ts";

function entry(partial = {}) {
  return {
    status: "ok",
    source: { subsystem: "session", operation: "reply" },
    usage: {
      input: { totalTokens: 100, uncachedTokens: 20 },
      output: { totalTokens: 40 },
      cache: { support: "reported", readTokens: 80 },
    },
    startedAt: "2026-08-19T08:00:00.000Z",
    endedAt: "2026-08-19T08:00:01.000Z",
    ...partial,
  };
}

describe("summarizeTurnUsage", () => {
  it("weights cache hit across the whole turn and estimates tok/s from wall time", () => {
    const stats = summarizeTurnUsage([
      entry({
        usage: {
          input: { totalTokens: 1000, uncachedTokens: 100 },
          output: { totalTokens: 50 },
          cache: { support: "reported", readTokens: 900 },
        },
      }),
      entry({
        startedAt: "2026-08-19T08:00:01.000Z",
        endedAt: "2026-08-19T08:00:02.000Z",
        usage: {
          input: { totalTokens: 100, uncachedTokens: 100 },
          output: { totalTokens: 50 },
          cache: { support: "reported", readTokens: 0 },
        },
      }),
    ], {
      startedAt: "2026-08-19T08:00:00.000Z",
      endedAt: "2026-08-19T08:00:02.000Z",
    });

    expect(stats).toMatchObject({
      calls: 2,
      input: 1100,
      output: 100,
      cacheRead: 900,
    });
    expect(stats.hitRatio).toBeCloseTo(900 / 1100);
    expect(stats.tokensPerSec).toBeCloseTo(50);
  });

  it("ignores utility and failed requests", () => {
    const stats = summarizeTurnUsage([
      entry(),
      entry({ status: "error" }),
      entry({ source: { subsystem: "utility", operation: "reply" } }),
    ]);
    expect(stats?.calls).toBe(1);
    expect(stats?.input).toBe(100);
  });
});

describe("turnUsageFromPiAssistantUsage", () => {
  it("converts the last assistant usage blob", () => {
    expect(turnUsageFromPiAssistantUsage({
      input: 200,
      output: 20,
      cacheRead: 50,
      cacheWrite: 0,
    })).toMatchObject({
      input: 200,
      output: 20,
      cacheRead: 50,
      hitRatio: 50 / 200,
    });
  });
});

describe("assignTurnUsageToAssistants", () => {
  it("assigns earlier usage to earlier assistant messages", () => {
    const assigned = assignTurnUsageToAssistants([
      { timestamp: Date.parse("2026-08-19T08:00:02.000Z") },
      { timestamp: Date.parse("2026-08-19T08:00:10.000Z") },
    ], [
      entry({ endedAt: "2026-08-19T08:00:01.000Z" }),
      entry({
        startedAt: "2026-08-19T08:00:08.000Z",
        endedAt: "2026-08-19T08:00:09.000Z",
        usage: {
          input: { totalTokens: 10, uncachedTokens: 10 },
          output: { totalTokens: 5 },
          cache: { support: "reported", readTokens: 0 },
        },
      }),
    ]);
    expect(assigned[0]?.input).toBe(100);
    expect(assigned[1]?.input).toBe(10);
  });
});

describe("format helpers", () => {
  it("compacts thousands", () => {
    expect(compactTokenCount(2600)).toBe("2.6k");
    expect(compactTokenCount(377)).toBe("377");
  });

  it("formats speed with modest precision", () => {
    expect(formatTurnUsageSpeed(18.2)).toBe("18.2");
    expect(formatTurnUsageSpeed(140)).toBe("140");
  });
});
