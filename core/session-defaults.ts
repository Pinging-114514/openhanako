import { SettingsManager } from "../lib/pi-sdk/index.ts";

/** 默认 session settings */
export function createDefaultSettings() {
  return SettingsManager.inMemory({
    steeringMode: "all",
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20_000,
    },
    // Agent-loop retry is already on by Pi default; set it explicitly and also
    // give the OpenAI/xAI Responses transport three SDK-level retries so
    // capacity / 429 failures are not a one-shot silent empty bubble.
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: {
        maxRetries: 3,
        maxRetryDelayMs: 60_000,
      },
    },
  });
}
