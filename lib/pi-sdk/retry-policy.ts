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
  const kind = classifyProviderError(text);
  if (kind === 'quota' || kind === 'auth' || kind === 'request_too_large') return false;
  return HANA_RETRYABLE_ERROR_PATTERN.test(text);
}

export function isHanaRetryableAssistantError(message: any): boolean {
  if (!message || message.stopReason !== "error") return false;
  return isHanaRetryableErrorMessage(message.errorMessage);
}

export type ProviderErrorFormatOptions = {
  retryAttempted?: boolean;
};

export type ProviderErrorClass =
  | "request_too_large"
  | "quota"
  | "capacity"
  | "auth"
  | "rate"
  | "transport"
  | "unknown";

function textForProviderErrorClass(raw: string): string {
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi, " ")
    .replace(/["']?(?:request[_ -]?id|x-request-id)["']?\s*[:=]\s*["'][^"']*["']/gi, " ")
    .replace(/\b(?:request[_ -]?id|x-request-id)\b\s*[:=]?\s*[A-Za-z0-9._:-]+/gi, " ");
}

function hasHttpStatus(body: string, status: number): boolean {
  return new RegExp(`(?:^|[\\r\\n])\\s*${status}\\b|\\b(?:http(?:/\\d(?:\\.\\d)?)?|status(?:_?code)?|error)["']?\\s*[:=]?\\s*["']?${status}\\b`, 'i').test(body);
}

function hasRateSignal(body: string): boolean {
  if (/\brate[_\s-]?limits?(?:_exceeded|_error|_reached)?\b/i.test(body)) return true;
  if (/\btoo many requests\b/i.test(body)) return true;
  return hasHttpStatus(body, 429);
}

export function classifyProviderError(errorMessage: unknown): ProviderErrorClass {
  const text = String(errorMessage || "").trim();
  if (!text) return "unknown";
  const body = textForProviderErrorClass(text);
  if (/request too large|tokens must be reduced|maximum context length|context_length_exceeded|string_above_max_length|input is too long/i.test(body)) {
    return "request_too_large";
  }
  if (hasHttpStatus(body, 402) || /insufficient_quota|exceeded your current quota|billing|credit balance|payment required|quota exceeded/i.test(body)) {
    return "quota";
  }
  if (/at capacity|high demand|resource.?exhausted|server.?busy|\bcapacity\b/i.test(body)) {
    return "capacity";
  }
  const rate = hasRateSignal(body);
  const auth = hasHttpStatus(body, 401) || hasHttpStatus(body, 403)
    || /invalid api key|incorrect api key|unauthorized|authentication failed|invalid_api_key/i.test(body);
  if (auth && !rate) return "auth";
  if (rate) return "rate";
  if (auth) return "auth";
  if (/timeout|timed?\s*out|\bnetwork\b|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(body)) {
    return "transport";
  }
  return "unknown";
}

function briefProviderError(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 300) return compact;
  return `${compact.slice(0, 297)}...`;
}

function withRetryNote(message: string, isZh: boolean, retryAttempted: boolean): string {
  if (!retryAttempted) return message;
  return isZh ? `${message}自动重试也没过去。` : `${message} Automatic retries were already attempted.`;
}

export function formatUserFacingProviderError(
  errorMessage: unknown,
  locale = "zh",
  options?: ProviderErrorFormatOptions,
): string {
  const text = String(errorMessage || "").trim();
  const isZh = String(locale || "").toLowerCase().startsWith("zh");
  const retryAttempted = options?.retryAttempted === true;
  const kind = classifyProviderError(text);
  const detail = text ? (isZh ? `详情：${briefProviderError(text)}` : `Detail: ${briefProviderError(text)}`) : "";

  if (kind === "request_too_large") {
    const message = isZh
      ? `这一次请求太大，单次装不下。缩短上下文或拆开再发。${detail}`
      : `This single request is too large. Shorten the context or split it. ${detail}`;
    return withRetryNote(message, isZh, retryAttempted);
  }

  if (kind === "quota") {
    const message = isZh
      ? `额度或账单不够了，等刷新或换个还有额度的账号。${detail}`
      : `Quota or billing is exhausted. Wait for a reset or switch to an account that still has quota. ${detail}`;
    return withRetryNote(message, isZh, retryAttempted);
  }

  if (kind === "capacity") {
    const message = isZh
      ? "模型现在太忙了，排队满了。稍等一两分钟再发一句，或换个模型试试。"
      : "The model is at capacity right now. Wait a minute and send again, or switch models.";
    return withRetryNote(message, isZh, retryAttempted);
  }

  if (kind === "auth") {
    const message = isZh
      ? `认证没通过。检查登录或 API key。${detail}`
      : `Authentication failed. Check the login or API key. ${detail}`;
    return withRetryNote(message, isZh, retryAttempted);
  }

  if (kind === "rate") {
    const message = isZh
      ? `触发了速率限制。稍后再试。${detail}`
      : `Hit a rate limit. Try again in a moment. ${detail}`;
    return withRetryNote(message, isZh, retryAttempted);
  }

  if (kind === "transport") {
    const message = isZh
      ? `网络或上游超时了。检查一下网络或代理后再试。${detail}`
      : `Network or upstream timed out. Check the network or proxy and try again. ${detail}`;
    return withRetryNote(message, isZh, retryAttempted);
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
    // Deterministic failures cannot be fixed by repeating the same request. Pi's broad
    // legacy text matcher can otherwise mistake a help URL or token number for throttling.
    const kind = classifyProviderError(message?.errorMessage);
    if (kind === 'quota' || kind === 'auth' || kind === 'request_too_large') return false;
    try {
      if (original?.(message)) return true;
    } catch {
      // fall through to Hana classifier
    }
    return isHanaRetryableAssistantError(message);
  };
  session[RETRY_POLICY_FLAG] = true;
}
