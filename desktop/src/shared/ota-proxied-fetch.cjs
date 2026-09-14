"use strict";

/**
 * ota-proxied-fetch.cjs — Electron-main fetchOnce for artifact OTA.
 *
 * Channel checks and digest history must use the same proxy the Chromium
 * session already applied. Node `https.request` + `proxy-agent` used to
 * drop a hop to DIRECT (GitHub's `release-assets.githubusercontent.com`
 * CDN, or a dead agent after ECONNREFUSED), which looks like
 * "检查更新失败" while chat still works through the ladder.
 *
 * Production passes Electron `net` so every hop stays on that session.
 * The Node path is the test / non-Electron fallback: once a proxy URL is
 * seen it is pinned, and a refused agent is rebuilt instead of falling
 * through to a bare connect.
 */

const https = require("https");
const { ProxyAgent } = require("proxy-agent");

function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    const text = Array.isArray(value) ? String(value[0] || "") : String(value ?? "");
    out[key] = text;
    out[String(key).toLowerCase()] = text;
  }
  return out;
}

function headerValue(headers, name) {
  if (!headers) return "";
  const direct = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || "");
  return String(direct || "");
}

function drainStream(stream) {
  if (!stream || typeof stream.resume !== "function") return;
  stream.resume();
}

function isProxyConnectError(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || err || "");
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|socket hang up|timed out/i
    .test(`${code} ${message}`);
}

function nodeHttpsFetchOnce(url, requestOpts) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.request(url, requestOpts, (res) => {
        resolve({ statusCode: res.statusCode, headers: res.headers, bodyStream: res });
      });
    } catch (err) {
      reject(err);
      return;
    }
    req.on("timeout", () => req.destroy(new Error(`artifact-ota: request timed out for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

function electronFetchOnce(electronNet, getSession, url, { headers = {}, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let request;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    try {
      const ses = typeof getSession === "function" ? getSession() : null;
      request = electronNet.request({
        method: "GET",
        url,
        session: ses || undefined,
        redirect: "follow",
      });
    } catch (err) {
      finish(err);
      return;
    }

    for (const [key, value] of Object.entries(headers || {})) {
      if (value == null || value === "") continue;
      request.setHeader(key, String(value));
    }

    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => {
        try { request.abort(); } catch { /* already closed */ }
        finish(new Error(`artifact-ota: request timed out for ${url}`));
      }, Number(timeoutMs));
    }

    request.on("response", (response) => {
      finish(null, {
        statusCode: response.statusCode,
        headers: normalizeHeaders(response.headers),
        bodyStream: response,
      });
    });
    request.on("error", (err) => finish(err));
    request.on("abort", () => {
      if (!settled) finish(new Error(`artifact-ota: request aborted for ${url}`));
    });
    request.end();
  });
}

/**
 * @param {{
 *   getProxyUrl?: (targetUrl: string) => (string|Promise<string>),
 *   log?: (msg: string) => void,
 *   electronNet?: { request: Function } | null,
 *   getSession?: () => unknown,
 *   requestImpl?: Function,
 * }} [opts]
 * @returns {(url: string, opts: {headers?: object, timeoutMs?: number}) => Promise<{statusCode:number, headers:object, bodyStream:any}>}
 */
function createOtaFetchOnce(opts = {}) {
  const {
    getProxyUrl = async () => "",
    log = () => {},
    electronNet = null,
    getSession = null,
    requestImpl = nodeHttpsFetchOnce,
  } = opts;
  const agentCache = new Map();
  let pinnedProxyUrl = "";

  function agentFor(proxyUrl) {
    let agent = agentCache.get(proxyUrl);
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
      agentCache.set(proxyUrl, agent);
    }
    return agent;
  }

  function dropAgent(proxyUrl) {
    const agent = agentCache.get(proxyUrl);
    agentCache.delete(proxyUrl);
    try { agent?.destroy?.(); } catch { /* ignore */ }
  }

  return async function proxiedFetchOnce(url, { headers = {}, timeoutMs } = {}) {
    if (electronNet && typeof electronNet.request === "function") {
      return electronFetchOnce(electronNet, getSession, url, { headers, timeoutMs });
    }

    let resolved = "";
    try {
      resolved = String((await getProxyUrl(url)) || "").trim();
    } catch (err) {
      log(`[ota] proxy resolve failed for ${url}: ${err?.message || err}`);
    }
    if (resolved) pinnedProxyUrl = resolved;
    const proxyUrl = pinnedProxyUrl;

    const attempt = async (freshAgent) => {
      const requestOpts = {
        method: "GET",
        headers,
        timeout: timeoutMs,
      };
      if (proxyUrl) {
        if (freshAgent) dropAgent(proxyUrl);
        requestOpts.agent = agentFor(proxyUrl);
      }
      return requestImpl(url, requestOpts);
    };

    try {
      return await attempt(false);
    } catch (err) {
      if (!proxyUrl || !isProxyConnectError(err)) throw err;
      log(`[ota] proxy ${proxyUrl} failed for ${url} (${err?.code || err?.message}); retrying with a fresh agent`);
      return attempt(true);
    }
  };
}

/**
 * Fetch-shaped wrapper over createOtaFetchOnce. GitHub digest/history URLs
 * redirect to release-assets.githubusercontent.com (and used to land on
 * objects.githubusercontent.com); the train path follows the same hops
 * inside ota-core unless Electron net already followed them.
 * @param {{ getProxyUrl?: Function, log?: Function, electronNet?: object, getSession?: Function, requestImpl?: Function }} [opts]
 * @returns {(url: string, init?: {headers?: object, timeoutMs?: number, signal?: AbortSignal}) => Promise<{ok:boolean,status:number,text:Function,json:Function}>}
 */
function createProxiedFetch(opts = {}) {
  const fetchOnce = createOtaFetchOnce(opts);
  return async function proxiedFetch(url, init = {}) {
    const headers = { ...(init.headers || {}) };
    const timeoutMs = Number(init.timeoutMs) > 0 ? Number(init.timeoutMs) : 20_000;
    const signal = init.signal;
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    throwIfAborted();
    let current = String(url);
    for (let hop = 0; hop < 8; hop += 1) {
      throwIfAborted();
      const res = await fetchOnce(current, { headers, timeoutMs });
      const status = Number(res.statusCode || 0);
      const location = headerValue(res.headers, "location");
      if (status >= 300 && status < 400 && location) {
        current = new URL(location, current).href;
        drainStream(res.bodyStream);
        continue;
      }
      const chunks = [];
      for await (const chunk of res.bodyStream) {
        throwIfAborted();
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return {
        ok: status >= 200 && status < 300,
        status,
        url: current,
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    }
    throw new Error(`too many redirects for ${url}`);
  };
}

module.exports = {
  createOtaFetchOnce,
  createProxiedFetch,
  normalizeHeaders,
  isProxyConnectError,
};
