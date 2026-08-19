/**
 * Hana retry policy — expands Pi's transient-error classifier.
 *
 * Pi already retries assistant errors (default maxRetries=3), but xAI's
 * "currently at capacity due to high demand" is missing from the stock
 * pattern list, so capacity failures become empty bubbles with no retry.
 */

const HANA_RETRYABLE_ERROR_PATTERN = new RegExp(
  [
    "at capacity",
    "high demand",
    "resource.?exhausted",
    "try again in a few minutes",
    "please try again",
    "temporarily unavailable",
    "server.?busy",
    "capacity",
  ].join("|"),
  "i",
);

export function isHanaRetryableErrorMessage(errorMessage: unknown): boolean {
  const text = String(errorMessage || "").trim();
  if (!text) return false;
  return HANA_RETRYABLE_ERROR_PATTERN.test(text);
}

export function isHanaRetryableAssistantError(message: any): boolean {
  if (!message || message.stopReason !== "error") return false;
  return isHanaRetryableErrorMessage(message.errorMessage);
}

export function formatUserFacingProviderError(errorMessage: unknown, locale = "zh"): string {
  const text = String(errorMessage || "").trim();
  const isZh = String(locale || "").toLowerCase().startsWith("zh");

  if (/at capacity|high demand|resource.?exhausted|server.?busy|capacity/i.test(text)) {
    return isZh
      ? "模型现在太忙了，排队满了。我已经自动重试过，还是没挤进去。稍等一两分钟再发一句，或换个模型试试。"
      : "The model is at capacity right now. I already retried automatically and still could not get a slot. Wait a minute and send again, or switch models.";
  }

  if (/rate.?limit|too many requests|429/i.test(text)) {
    return isZh
      ? "触发了速率限制。我已经自动重试过，还是被挡住了。稍后再试。"
      : "Hit a rate limit. I already retried automatically and was still blocked. Try again in a moment.";
  }

  if (/timeout|timed? out|network|socket hang up|ECONNRESET|fetch failed/i.test(text)) {
    return isZh
      ? "网络或上游超时了。我已经自动重试过，还是没成功。检查一下网络或代理后再试。"
      : "Network or upstream timed out. I already retried automatically. Check the network/proxy and try again.";
  }

  if (text) {
    return isZh
      ? `这次回复失败了：${text}`
      : `This reply failed: ${text}`;
  }

  return isZh
    ? "这次回复失败了，而且没有具体错误信息。请再试一次。"
    : "This reply failed without a detailed error. Please try again.";
}

const RETRY_POLICY_FLAG = Symbol.for("hana.piSdk.retryPolicyInstalled");

/**
 * Widen AgentSession's retry classifier so capacity / high-demand errors
 * actually enter the existing auto-retry loop (default 3 attempts).
 */
export function installRetryPolicy(session: any) {
  if (!session || session[RETRY_POLICY_FLAG]) return;
  const original = typeof session._isRetryableError === "function"
    ? session._isRetryableError.bind(session)
    : null;
  session._isRetryableError = (message: any) => {
    try {
      if (original?.(message)) return true;
    } catch {
      // fall through to Hana classifier
    }
    return isHanaRetryableAssistantError(message);
  };
  session[RETRY_POLICY_FLAG] = true;
}
