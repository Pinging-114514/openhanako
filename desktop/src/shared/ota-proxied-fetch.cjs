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

module.exports = {
  createOtaFetchOnce,
};
