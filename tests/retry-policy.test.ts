import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  installRetryPolicy,
  formatUserFacingProviderError,
  isHanaRetryableAssistantError,
  isHanaRetryableErrorMessage,
} from "../lib/pi-sdk/retry-policy.ts";
import { ensureVisibleProviderError } from "../lib/pi-sdk/stream-guard.ts";

describe("Hana retry policy", () => {
  it.each([401, 402, 429])('does not interpret validation bound %s as a response status', (value) => {
    expect(classifyProviderError(`Invalid value: max_tokens must be below ${value}`)).toBe('unknown');
  });

  it('does not retry deterministic size, quota or authentication failures through the Pi fallback', () => {
    const session = { _isRetryableError: (_message?: unknown) => true };
    installRetryPolicy(session);
    for (const errorMessage of [
      'Request too large. Visit https://example.invalid/rate-limits',
      '429 insufficient_quota please try again',
      '401 Invalid API key',
    ]) {
      expect(session._isRetryableError({ stopReason: 'error', errorMessage } as never)).toBe(false);
    }
  });
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
    expect(message.content[0].text).not.toContain("已经自动重试");
  });

  it("classifies provider failures without treating urls or request ids as rate limits", () => {
    const help = "Visit https://platform.openai.com/account/rate-limits to learn more.";
    const tooLarge = `Request too large for model in organization org-anonymized on tokens per min (TPM): Limit 500000000, Requested 129074. The input or output tokens must be reduced in order to run successfully. ${help}`;
    expect(classifyProviderError(tooLarge)).toBe("request_too_large");
    expect(formatUserFacingProviderError(tooLarge, "zh")).toContain("Requested 129074");
    expect(formatUserFacingProviderError(tooLarge, "zh")).not.toContain("速率限制");

    expect(classifyProviderError(`Network timeout. ${help}`)).toBe("transport");
    expect(formatUserFacingProviderError(`Network timeout. ${help}`, "zh")).toContain("网络或上游超时");

    const auth = "401 Invalid API key (request id: req_1429abc)";
    expect(classifyProviderError(auth)).toBe("auth");
    expect(formatUserFacingProviderError(auth, "zh")).toContain("401 Invalid API key");
    expect(formatUserFacingProviderError(auth, "zh")).not.toContain("速率限制");

    const quota = '429 {"error":{"code":"insufficient_quota","message":"quota exceeded"}}';
    expect(classifyProviderError(quota)).toBe("quota");
    expect(formatUserFacingProviderError(quota, "zh")).toContain("insufficient_quota");
    expect(formatUserFacingProviderError(quota, "zh")).not.toContain("已经自动重试");

    const rate = "Rate limit reached for model on tokens per min (TPM).";
    expect(classifyProviderError(rate)).toBe("rate");
    expect(formatUserFacingProviderError(rate, "zh")).toContain("速率限制");
    expect(formatUserFacingProviderError(rate, "zh")).not.toContain("已经自动重试");
    expect(formatUserFacingProviderError(rate, "zh", { retryAttempted: true })).toContain("自动重试也没过去");

    const first = ensureVisibleProviderError({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "429 Too Many Requests",
    });
    expect(first.content[0].text).not.toContain("已经自动重试");
    expect(formatUserFacingProviderError("terminated", "zh")).toBe("这次回复失败了：terminated");

    const below = "Invalid value: max_tokens must be below 429";
    expect(classifyProviderError(below)).not.toBe("rate");
    expect(formatUserFacingProviderError(below, "zh")).toContain(below);
    expect(formatUserFacingProviderError(below, "zh")).not.toContain("速率限制");

    expect(classifyProviderError("rate_limit_exceeded")).toBe("rate");
    expect(formatUserFacingProviderError("rate_limit_exceeded", "zh")).toContain("rate_limit_exceeded");

    const quotedRequest = '401 {"error":{"message":"Invalid API key","request_id":"429"}}';
    expect(classifyProviderError(quotedRequest)).toBe("auth");
    expect(formatUserFacingProviderError(quotedRequest, "zh")).toContain("Invalid API key");
    expect(formatUserFacingProviderError(quotedRequest, "zh")).not.toContain("速率限制");
  });
});
