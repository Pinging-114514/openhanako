/**
 * xAI OAuth native search via cli-chat-proxy Responses API.
 *
 * This is a Hana-side tool backend (web_search / x_search), not a native
 * tool injection into Grok chat requests.
 */

import { XAI_OAUTH_RESOURCE_URL } from "../auth/xai-oauth.ts";
import {
  buildXaiOauthCliModelHeaders,
  buildXaiOauthCliProviderHeaders,
} from "../providers/xai-oauth-cli-headers.ts";

export const XAI_OAUTH_SEARCH_DEFAULT_MODEL = "grok-4.6";
export const XAI_OAUTH_SEARCH_TIMEOUT_MS = 90_000;

type FetchLike = typeof globalThis.fetch;

export function xaiOauthResponsesUrl() {
  return `${XAI_OAUTH_RESOURCE_URL.replace(/\/+$/, "")}/responses`;
}

export function extractXaiSearchText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks = [];
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") chunks.push(item.text);
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

export function collectXaiSearchCitations(data) {
  const urls = [];
  const push = (url) => {
    const value = String(url || "").trim();
    if (value && !urls.includes(value)) urls.push(value);
  };
  if (Array.isArray(data?.citations)) {
    for (const item of data.citations) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") push(item.url || item.uri);
    }
  }
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
        push(annotation?.url || annotation?.uri);
      }
    }
  }
  return urls;
}

export function resultsFromXaiSearch(result, maxResults = 10) {
  const limit = Number.isFinite(Number(maxResults)) ? Math.max(1, Math.floor(Number(maxResults))) : 10;
  const text = String(result?.text || "").trim();
  const citations = Array.isArray(result?.citations) ? result.citations.filter(Boolean) : [];
  if (citations.length === 0) {
    if (!text) return [];
    return [{
      title: "Grok search",
      url: "",
      snippet: text,
    }];
  }
  return citations.slice(0, limit).map((url, index) => {
    let title = url;
    try {
      title = new URL(url).hostname.replace(/^www\./, "") || url;
    } catch {
      // keep raw url
    }
    const fromX = isXSearchUrl(url);
    return {
      title: fromX ? `X · ${title}` : title,
      url,
      snippet: index === 0 ? text : "",
    };
  });
}

function redactError(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9._\-]+/g, "[redacted-jwt]");
}

export function isXSearchUrl(url) {
  try {
    const host = new URL(String(url || "")).hostname.replace(/^www\./, "").toLowerCase();
    return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

export async function callXaiOauthNativeSearch({
  toolType,
  tools,
  prompt,
  toolOptions = {},
  accessToken,
  modelId = XAI_OAUTH_SEARCH_DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = XAI_OAUTH_SEARCH_TIMEOUT_MS,
}: {
  toolType?: "web_search" | "x_search";
  tools?: Array<Record<string, any>>;
  prompt: string;
  toolOptions?: Record<string, any>;
  accessToken?: string | null;
  modelId?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {} as any) {
  const token = String(accessToken || "").trim();
  const query = String(prompt || "").trim();
  if (!token) {
    return { ok: false, error: "还没登录 xAI OAuth，或搜索工具已关闭。" };
  }
  if (!query) {
    return { ok: false, error: "query 不能为空" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "当前环境没有 fetch。" };
  }

  const model = String(modelId || XAI_OAUTH_SEARCH_DEFAULT_MODEL).trim() || XAI_OAUTH_SEARCH_DEFAULT_MODEL;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...buildXaiOauthCliProviderHeaders(),
    ...buildXaiOauthCliModelHeaders(model),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(xaiOauthResponsesUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: query }],
        tools: Array.isArray(tools) && tools.length
          ? tools
          : [{ type: toolType, ...toolOptions }],
        stream: false,
        store: false,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = { rawText: raw.slice(0, 500) };
    }
    if (!response.ok) {
      const message = redactError(data?.error?.message || data?.error || `HTTP ${response.status}`);
      return { ok: false, status: response.status, error: message, elapsedMs: Date.now() - started };
    }
    return {
      ok: true,
      status: response.status,
      elapsedMs: Date.now() - started,
      text: extractXaiSearchText(data),
      citations: collectXaiSearchCitations(data),
    };
  } catch (err: any) {
    const message = err?.name === "AbortError"
      ? `超时（>${timeoutMs}ms）。xAI 原生搜索有时会跑很久。`
      : redactError(err?.message || err);
    return { ok: false, error: message, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export function formatXaiSearchResult(result, label) {
  if (!result?.ok) {
    return `${label} 失败：${result?.error || "未知错误"}`;
  }
  const lines = [result.text || "(没有文本结果)"];
  if (result.citations?.length) {
    lines.push("");
    lines.push("来源：");
    for (const url of result.citations.slice(0, 8)) lines.push(`- ${url}`);
  }
  return lines.join("\n");
}
