const DEFAULT_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  if (value == null) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function extractAccountIdFromToken(token) {
  if (typeof token !== "string") return "";
  const [, payload] = token.split(".");
  if (!payload) return "";
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const accountId = data?.[CODEX_ACCOUNT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof accountId === "string" ? accountId.trim() : "";
  } catch {
    return "";
  }
}

function windowKind(seconds) {
  const n = asNumber(seconds);
  if (n == null) return "week";
  if (n >= 6 * 24 * 60 * 60) return "week";
  if (n >= 60 * 60) return "hours";
  return "window";
}

function parseResetAt(window) {
  const unix = asNumber(window?.reset_at);
  if (unix != null && unix > 1e12) return new Date(unix);
  if (unix != null && unix > 0) return new Date(unix * 1000);
  const after = asNumber(window?.reset_after_seconds);
  if (after != null && after >= 0) return new Date(Date.now() + after * 1000);
  return null;
}

export function summarizeCodexOauthUsage(data) {
  const window = data?.rate_limit?.primary_window;
  const used = clampPercent(asNumber(window?.used_percent));
  const remaining = used == null ? null : Math.max(0, 100 - used);
  const windowSeconds = asNumber(window?.limit_window_seconds);
  const reset = parseResetAt(window);
  const planType = typeof data?.plan_type === "string" && data.plan_type.trim()
    ? data.plan_type.trim()
    : null;
  return {
    ok: remaining != null,
    planType,
    used,
    remaining,
    windowSeconds,
    windowKind: windowKind(windowSeconds),
    resetAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null,
  };
}

export function resolveCodexUsageAccountId({ accountId, accessToken } = {}) {
  const direct = typeof accountId === "string" ? accountId.trim() : "";
  return direct || extractAccountIdFromToken(accessToken);
}

export async function fetchCodexOauthUsage({
  accessToken,
  accountId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  usageUrl = DEFAULT_CODEX_USAGE_URL,
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return {
      ok: false,
      error: "not_logged_in",
      planType: null,
      used: null,
      remaining: null,
      windowSeconds: null,
      windowKind: "week",
      resetAt: null,
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      error: "unavailable",
      planType: null,
      used: null,
      remaining: null,
      windowSeconds: null,
      windowKind: "week",
      resetAt: null,
    };
  }

  const resolvedAccountId = resolveCodexUsageAccountId({ accountId, accessToken: token });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
    };
    if (resolvedAccountId) {
      headers["chatgpt-account-id"] = resolvedAccountId;
      headers["ChatGPT-Account-ID"] = resolvedAccountId;
    }
    const response = await fetchImpl(usageUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!response.ok) {
      return {
        ok: false,
        error: "upstream",
        planType: null,
        used: null,
        remaining: null,
        windowSeconds: null,
        windowKind: "week",
        resetAt: null,
      };
    }
    return summarizeCodexOauthUsage(data);
  } catch {
    return {
      ok: false,
      error: "network",
      planType: null,
      used: null,
      remaining: null,
      windowSeconds: null,
      windowKind: "week",
      resetAt: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
