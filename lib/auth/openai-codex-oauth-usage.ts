import {
  classifyOauthUsageHttpError,
  emptyOauthUsage,
  mergeOauthUsageSnapshot,
  publicOauthUsage,
} from "../../shared/oauth-usage.ts";

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
    error: remaining != null ? null : "unavailable",
    stale: false,
  };
}

export function resolveCodexUsageAccountId({
  accountId,
  accessToken,
}: {
  accountId?: unknown;
  accessToken?: unknown;
} = {}) {
  const direct = typeof accountId === "string" ? accountId.trim() : "";
  return direct || extractAccountIdFromToken(accessToken);
}

export async function fetchCodexOauthUsage({
  accessToken,
  accountId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  usageUrl = DEFAULT_CODEX_USAGE_URL,
}: {
  accessToken?: unknown;
  accountId?: unknown;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  usageUrl?: string;
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ...emptyOauthUsage("not_logged_in"), used: null };
  }
  if (typeof fetchImpl !== "function") {
    return { ...emptyOauthUsage("unavailable"), used: null };
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
      return { ...emptyOauthUsage(classifyOauthUsageHttpError(response.status, raw)), used: null };
    }
    return summarizeCodexOauthUsage(data);
  } catch {
    return { ...emptyOauthUsage("network"), used: null };
  } finally {
    clearTimeout(timer);
  }
}

export function publicCodexOauthUsage(usage) {
  return publicOauthUsage(usage);
}

export async function refreshCodexOauthUsageCache(engine, {
  fetchImpl,
}: {
  fetchImpl?: typeof globalThis.fetch;
} = {}) {
  if (engine?.codexOauthUsageInflight) return engine.codexOauthUsageInflight;
  const work = (async () => {
    const cred = engine?.authStorage?.get?.("openai-codex");
    if (cred?.type !== "oauth" || !cred.access) {
      if (engine) engine.codexOauthUsage = null;
      return null;
    }
    const usage = await fetchCodexOauthUsage({
      accessToken: cred.access,
      accountId: cred.accountId || cred.account_id || "",
      fetchImpl,
    });
    engine.codexOauthUsage = mergeOauthUsageSnapshot(engine.codexOauthUsage, usage) || usage;
    return engine.codexOauthUsage;
  })();
  if (engine) engine.codexOauthUsageInflight = work;
  try {
    return await work;
  } finally {
    if (engine && engine.codexOauthUsageInflight === work) engine.codexOauthUsageInflight = null;
  }
}

export async function readCodexOauthUsageCached(engine, {
  fetchImpl,
}: {
  fetchImpl?: typeof globalThis.fetch;
} = {}) {
  if (engine?.codexOauthUsage) return engine.codexOauthUsage;
  return refreshCodexOauthUsageCache(engine, { fetchImpl });
}
