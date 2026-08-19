import { describe, expect, it } from "vitest";
import {
  formatUserFacingProviderError,
  isHanaRetryableAssistantError,
  isHanaRetryableErrorMessage,
} from "../lib/pi-sdk/retry-policy.ts";
import { ensureVisibleProviderError } from "../lib/pi-sdk/stream-guard.ts";

describe("Hana retry policy", () => {
  it("treats xAI capacity errors as retryable", () => {
    const message = {
      stopReason: "error",
      errorMessage: "The model is currently at capacity due to high demand. Please try again in a few minutes.",
    };
    expect(isHanaRetryableErrorMessage(message.errorMessage)).toBe(true);
    expect(isHanaRetryableAssistantError(message)).toBe(true);
  });

  it("does not treat empty or successful messages as retryable", () => {
    expect(isHanaRetryableAssistantError({ stopReason: "stop", errorMessage: "" })).toBe(false);
    expect(isHanaRetryableAssistantError({ stopReason: "error" })).toBe(false);
  });

  it("injects a visible chat explanation when the error bubble would otherwise be empty", () => {
    const message = ensureVisibleProviderError({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "The model is currently at capacity due to high demand.",
    });
    expect(message.content).toEqual([
      {
        type: "text",
        text: formatUserFacingProviderError(message.errorMessage, "zh"),
      },
    ]);
  });
});
