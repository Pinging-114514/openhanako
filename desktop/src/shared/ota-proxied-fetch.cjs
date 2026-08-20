"use strict";

/**
 * ota-proxied-fetch.cjs — Electron-main fetchOnce for artifact OTA.
 *
 * The shared ota-core transport is a bare https.request. That ignores
 * Hana's Settings > Network proxy and Windows system proxy, so GitHub
 * channel checks fail with ECONNRESET while the browser still works behind
 * a ladder/VPN. This wrapper injects a proxy-agent per URL.
 */

const https = require("https");
const { ProxyAgent } = require("proxy-agent");

/**
 * @param {{
 *   getProxyUrl?: (targetUrl: string) => (string|Promise<string>),
 *   log?: (msg: string) => void,
 * }} [opts]
 * @returns {(url: string, opts: {headers?: object, timeoutMs?: number}) => Promise<{statusCode:number, headers:object, bodyStream:any}>}
 */
function createOtaFetchOnce(opts = {}) {
  const {
    getProxyUrl = async () => "",
    log = () => {},
  } = opts;
  const agentCache = new Map();

  return async function proxiedFetchOnce(url, { headers = {}, timeoutMs } = {}) {
    let proxyUrl = "";
    try {
      proxyUrl = String((await getProxyUrl(url)) || "").trim();
    } catch (err) {
      log(`[ota] proxy resolve failed for ${url}: ${err?.message || err}`);
      proxyUrl = "";
    }

    let agent = undefined;
    if (proxyUrl) {
      agent = agentCache.get(proxyUrl);
      if (!agent) {
        agent = new ProxyAgent(proxyUrl);
        agentCache.set(proxyUrl, agent);
      }
    }

    return new Promise((resolve, reject) => {
      let req;
      try {
        const requestOpts = {
          method: "GET",
          headers,
          timeout: timeoutMs,
        };
        if (agent) requestOpts.agent = agent;
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
  };
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

/**
 * Fetch-shaped wrapper over createOtaFetchOnce. GitHub digest/history URLs
 * redirect to objects.githubusercontent.com; the OTA train path does not.
 * @param {{ getProxyUrl?: Function, log?: Function }} [opts]
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
};
