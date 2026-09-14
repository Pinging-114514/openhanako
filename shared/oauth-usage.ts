/**
 * Codex / Grok OAuth 周用量的对外形状。
 *
 * 取数失败不能只剩 ok:false：设置页要把「号废了 / 没额度 / 网络挂了」分开说。
 * 暂态失败还要保住上次读到的 remaining，不然 Grok 刷新一抖就会在数字和「读不到」之间闪。
 */

export const OAUTH_USAGE_ERRORS = [
  "not_logged_in",
  "auth_revoked",
  "network",
  "rate_limited",
  "upstream",
  "unavailable",
] as const;

export type OauthUsageError = (typeof OAUTH_USAGE_ERRORS)[number];
export type OauthUsageWindowKind = "week" | "hours" | "window";

export type OauthUsageSnapshot = {
  ok: boolean;
  remaining: number | null;
  used?: number | null;
  resetAt: string | null;
  planType: string | null;
  windowKind: OauthUsageWindowKind;
  windowSeconds: number | null;
  error: OauthUsageError | null;
  stale: boolean;
};

const TRANSIENT_ERRORS = new Set<OauthUsageError>([
  "network",
  "rate_limited",
  "upstream",
  "unavailable",
]);

const OAUTH_USAGE_ERROR_SET = new Set<string>(OAUTH_USAGE_ERRORS);

const REVOKED_RE = /token_revoked|invalidated oauth token|refresh_token_invalidated|invalid_refresh_token|your session has ended|invalid_token/i;

export function isOauthUsageError(value: unknown): value is OauthUsageError {
  return typeof value === "string" && OAUTH_USAGE_ERROR_SET.has(value);
}

export function looksLikeOauthTokenRevoked(text: unknown): boolean {
  return typeof text === "string" && REVOKED_RE.test(text);
}

/** 聊天里上游常把 token_revoked 写在英文 message 里，没有稳定错误码。 */
export function inferOauthAuthErrorCode(message: unknown): "token_revoked" | null {
  return looksLikeOauthTokenRevoked(message) ? "token_revoked" : null;
}

export function classifyOauthUsageHttpError(status: number, bodyText?: string): OauthUsageError {
  if (looksLikeOauthTokenRevoked(bodyText) || status === 401 || status === 403) {
    return "auth_revoked";
  }
  if (status === 429) return "rate_limited";
  return "upstream";
}

export function isTransientOauthUsageError(error: unknown): boolean {
  return isOauthUsageError(error) && TRANSIENT_ERRORS.has(error);
}

export function emptyOauthUsage(error: OauthUsageError | null = null): OauthUsageSnapshot {
  return {
    ok: false,
    remaining: null,
    used: null,
    resetAt: null,
    planType: null,
    windowKind: "week",
    windowSeconds: null,
    error,
    stale: false,
  };
}

export function publicOauthUsage(usage: unknown): OauthUsageSnapshot | null {
  if (!usage || typeof usage !== "object") return null;
  const item = usage as Record<string, unknown>;
  const remaining = typeof item.remaining === "number" && Number.isFinite(item.remaining)
    ? item.remaining
    : null;
  const used = typeof item.used === "number" && Number.isFinite(item.used) ? item.used : null;
  const ok = item.ok === true && remaining != null;
  return {
    ok,
    remaining,
    used,
    resetAt: typeof item.resetAt === "string" ? item.resetAt : null,
    planType: typeof item.planType === "string" ? item.planType : null,
    windowKind: item.windowKind === "hours" || item.windowKind === "window" ? item.windowKind : "week",
    windowSeconds: typeof item.windowSeconds === "number" && Number.isFinite(item.windowSeconds)
      ? item.windowSeconds
      : null,
    error: ok ? null : (isOauthUsageError(item.error) ? item.error : "unavailable"),
    stale: item.stale === true && remaining != null,
  };
}

/**
 * 成功覆盖；号废了覆盖；网络/上游失败则保住上次 remaining，并标 stale。
 */
export function mergeOauthUsageSnapshot(
  previous: unknown,
  next: unknown,
): OauthUsageSnapshot | null {
  const incoming = publicOauthUsage(next);
  if (!incoming) return publicOauthUsage(previous);
  if (incoming.ok || !isTransientOauthUsageError(incoming.error)) return incoming;
  const prior = publicOauthUsage(previous);
  if (typeof prior?.remaining !== "number") return incoming;
  return {
    ...prior,
    ok: false,
    error: incoming.error,
    stale: true,
  };
}
