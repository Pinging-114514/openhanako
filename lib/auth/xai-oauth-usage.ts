import {
  classifyOauthUsageHttpError,
  emptyOauthUsage,
  mergeOauthUsageSnapshot,
  publicOauthUsage,
} from "../../shared/oauth-usage.ts";
import { XAI_OAUTH_RESOURCE_URL, XAI_OAUTH_USERINFO_URL } from "./xai-oauth.ts";
import { buildXaiOauthCliProviderHeaders } from "../providers/xai-oauth-cli-headers.ts";

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function configOf(data) {
  return data?.config && typeof data.config === "object" ? data.config : data;
}

function parsePercent(data) {
  const config = configOf(data);
  return asNumber(config?.creditUsagePercent)
    ?? asNumber(config?.credit_usage_percent)
    ?? asNumber(config?.usagePercent)
    ?? asNumber(data?.creditUsagePercent)
    ?? asNumber(data?.usagePercent);
}

function parsePeriodEnd(data) {
  const config = configOf(data);
  const period = config?.currentPeriod || config?.current_period || data?.currentPeriod || null;
  const endRaw = period?.end || period?.endsAt || config?.billing_period_end || config?.billingPeriodEnd;
  const end = endRaw ? new Date(endRaw) : null;
  return end && !Number.isNaN(end.getTime()) ? end : null;
}

const XAI_SETTINGS_TIMEOUT_MS = 4_000;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** SuperGrok Heavy / SuperGrok → heavy / super，和 Codex 卡片上的 pro 同一档短标签。 */
export function normalizeXaiOauthPlanType(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const compact = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact.includes("heavy")) return "heavy";
  if (compact === "super" || compact === "supergrok") return "super";
  return text.length <= 32 ? text : null;
}

export function parseXaiOauthPlanType(data) {
  if (!data || typeof data !== "object") return null;
  const config = configOf(data);
  return normalizeXaiOauthPlanType(firstString(
    data.subscription_tier_display,
    data.subscriptionTierDisplay,
    data.subscription_tier,
    data.subscriptionTier,
    config?.subscription_tier_display,
    config?.subscription_tier,
    config?.subscriptionTier,
    data.planType,
    data.plan_type,
    data.plan,
  ));
}

async function readXaiOauthJson(fetchImpl, url, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...buildXaiOauthCliProviderHeaders(),
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    return { response, raw, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchXaiOauthPlanType({
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = XAI_SETTINGS_TIMEOUT_MS,
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token || typeof fetchImpl !== "function") return null;
  const url = `${XAI_OAUTH_RESOURCE_URL.replace(/\/+$/, "")}/settings`;
  try {
    const { response, data } = await readXaiOauthJson(fetchImpl, url, token, timeoutMs);
    if (!response.ok) return null;
    return parseXaiOauthPlanType(data);
  } catch {
    return null;
  }
}

export function summarizeXaiOauthUsage(data) {
  const percent = parsePercent(data);
  const used = percent == null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  const remaining = used == null ? null : Math.max(0, 100 - used);
  const resetAt = parsePeriodEnd(data);
  return {
    ok: used != null,
    used,
    remaining,
    resetAt: resetAt ? resetAt.toISOString() : null,
    planType: parseXaiOauthPlanType(data),
    error: used != null ? null : "unavailable",
    stale: false,
  };
}

export async function fetchXaiOauthUsage({
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ...emptyOauthUsage("not_logged_in"), used: null };
  }
  if (typeof fetchImpl !== "function") {
    return { ...emptyOauthUsage("unavailable"), used: null };
  }
  const base = XAI_OAUTH_RESOURCE_URL.replace(/\/+$/, "");
  const settingsPromise = fetchXaiOauthPlanType({
    accessToken: token,
    fetchImpl,
    timeoutMs: Math.min(XAI_SETTINGS_TIMEOUT_MS, timeoutMs),
  });
  try {
    const { response, raw, data } = await readXaiOauthJson(
      fetchImpl,
      `${base}/billing?format=credits`,
      token,
      timeoutMs,
    );
    if (!response.ok) {
      return { ...emptyOauthUsage(classifyOauthUsageHttpError(response.status, raw)), used: null };
    }
    const usage = summarizeXaiOauthUsage(data);
    const settingsPlan = await settingsPromise;
    return { ...usage, planType: settingsPlan || usage.planType || null };
  } catch {
    return { ...emptyOauthUsage("network"), used: null };
  }
}

export async function fetchXaiOauthUserinfo({
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) return { email: "", name: "" };
  if (typeof fetchImpl !== "function") return { email: "", name: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(XAI_OAUTH_USERINFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!response.ok || !data || typeof data !== "object") {
      return { email: "", name: "" };
    }
    const email = typeof data.email === "string" && data.email.includes("@")
      ? data.email.trim()
      : "";
    const preferred = typeof data.preferred_username === "string" ? data.preferred_username.trim() : "";
    const name = typeof data.name === "string" ? data.name.trim() : "";
    return {
      email: email || (preferred.includes("@") ? preferred : ""),
      name,
    };
  } catch {
    return { email: "", name: "" };
  } finally {
    clearTimeout(timer);
  }
}

export function publicXaiOauthUsage(usage) {
  return publicOauthUsage(usage);
}

export async function refreshXaiOauthUsageCache(engine, { fetchImpl } = {}) {
  if (engine?.xaiOauthUsageInflight) return engine.xaiOauthUsageInflight;
  const work = (async () => {
    const cred = engine?.authStorage?.get?.("xai-oauth");
    if (cred?.type !== "oauth" || !cred.access) {
      if (engine) engine.xaiOauthUsage = null;
      return null;
    }
    const usage = await fetchXaiOauthUsage({
      accessToken: cred.access,
      fetchImpl,
    });
    engine.xaiOauthUsage = mergeOauthUsageSnapshot(engine.xaiOauthUsage, usage) || usage;
    return engine.xaiOauthUsage;
  })();
  if (engine) engine.xaiOauthUsageInflight = work;
  try {
    return await work;
  } finally {
    if (engine && engine.xaiOauthUsageInflight === work) engine.xaiOauthUsageInflight = null;
  }
}

export async function readXaiOauthUsageCached(engine, { fetchImpl } = {}) {
  if (engine?.xaiOauthUsage) return engine.xaiOauthUsage;
  return refreshXaiOauthUsageCache(engine, { fetchImpl });
}
