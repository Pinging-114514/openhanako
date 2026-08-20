import { XAI_OAUTH_RESOURCE_URL } from "./xai-oauth.ts";
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
  };
}

export async function fetchXaiOauthUsage({
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return { ok: false, error: "not_logged_in", used: null, remaining: null, resetAt: null };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "unavailable", used: null, remaining: null, resetAt: null };
  }
  const url = `${XAI_OAUTH_RESOURCE_URL.replace(/\/+$/, "")}/billing?format=credits`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...buildXaiOauthCliProviderHeaders(),
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!response.ok) {
      return { ok: false, error: "upstream", used: null, remaining: null, resetAt: null };
    }
    return summarizeXaiOauthUsage(data);
  } catch {
    return { ok: false, error: "network", used: null, remaining: null, resetAt: null };
  } finally {
    clearTimeout(timer);
  }
}
