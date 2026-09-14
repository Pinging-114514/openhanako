#!/usr/bin/env node
/**
 * Convert Grok Web SSO cookies into HanaAgent xai-oauth credential JSON.
 * Writes files only. Never prints cookies or tokens.
 */
import fs from "node:fs";
import path from "node:path";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const ACCOUNTS_URL = "https://accounts.x.ai/";
const ISSUER = "https://auth.x.ai";
const DEVICE_URL = `${ISSUER}/oauth2/device/code`;
const VERIFY_URL = `${ISSUER}/oauth2/device/verify`;
const APPROVE_URL = `${ISSUER}/oauth2/device/approve`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const USERINFO_URL = `${ISSUER}/oauth2/userinfo`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_TTL_SEC = 6 * 60 * 60;

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, code, message }));
  process.exit(1);
}

function parseArgs(argv) {
  const files = [];
  const tokenEnvs = [];
  let out = "";
  let proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
  let bundle = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--file" && next) { files.push(next); i++; continue; }
    if (arg === "--token-env" && next) { tokenEnvs.push(next); i++; continue; }
    if (arg === "--out" && next) { out = next; i++; continue; }
    if (arg === "--proxy" && next) { proxy = next; i++; continue; }
    if (arg === "--bundle") { bundle = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log("usage: convert.mjs --file sso.txt --out dir [--proxy url] [--bundle]");
      process.exit(0);
    }
    fail("bad_args", `unknown argument: ${arg}`);
  }
  return { files, tokenEnvs, out, proxy, bundle };
}

function normalizeSsoToken(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (text.toLowerCase().startsWith("cookie:")) text = text.slice(7).trim();
  for (const part of text.split(";")) {
    const cut = part.indexOf("=");
    if (cut < 0) continue;
    const name = part.slice(0, cut).trim().toLowerCase();
    const token = part.slice(cut + 1).trim();
    if (name === "sso" || name === "sso-rw") return sanitizeToken(token);
  }
  return sanitizeToken(text.split(";")[0] || text);
}

function sanitizeToken(value) {
  const token = String(value || "").replace(/[\r\n\x00]/g, "").trim();
  return token && token.length <= 16 * 1024 ? token : "";
}

function readTokens({ files, tokenEnvs }) {
  const tokens = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const token = normalizeSsoToken(line);
      if (token) tokens.push(token);
    }
  }
  for (const name of tokenEnvs) {
    const token = normalizeSsoToken(process.env[name] || "");
    if (token) tokens.push(token);
  }
  return [...new Set(tokens)];
}

function firstEmail(...values) {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.includes("@")) return text;
  }
  return "";
}

function cookieJar() {
  const byHost = new Map();
  return {
    seed(token) {
      for (const host of ["accounts.x.ai", "auth.x.ai"]) {
        const bag = byHost.get(host) || new Map();
        bag.set("sso", token);
        bag.set("sso-rw", token);
        byHost.set(host, bag);
      }
    },
    capture(url, response) {
      const host = new URL(url).hostname.toLowerCase();
      const bag = byHost.get(host) || new Map();
      for (const raw of response.headers.getSetCookie?.() || []) {
        const pair = String(raw).split(";")[0] || "";
        const cut = pair.indexOf("=");
        if (cut < 0) continue;
        const name = pair.slice(0, cut).trim();
        const value = pair.slice(cut + 1).trim();
        if (!name || name.length > 128 || value.length > 16384) continue;
        bag.set(name, value);
      }
      byHost.set(host, bag);
    },
    header(url) {
      const bag = byHost.get(new URL(url).hostname.toLowerCase());
      if (!bag || bag.size === 0) return "";
      return [...bag.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
  };
}

function trustedXaiUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return ""; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:") return "";
  if (host !== "x.ai" && !host.endsWith(".x.ai")) return "";
  if (parsed.username || parsed.password) return "";
  return parsed.toString();
}

async function makeFetch(proxy) {
  if (!proxy) return globalThis.fetch;
  try {
    const undici = await import("undici");
    const agent = new undici.ProxyAgent(proxy);
    return (url, init = {}) => undici.fetch(url, { ...init, dispatcher: agent });
  } catch {
    return globalThis.fetch;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function request(fetchImpl, jar, method, url, form, signal) {
  let currentUrl = trustedXaiUrl(url);
  if (!currentUrl) throw Object.assign(new Error("untrusted_url"), { code: "untrusted_url" });
  let currentMethod = method;
  let currentForm = form;
  for (let hop = 0; hop <= 8; hop++) {
    const headers = {
      Accept: "application/json, text/html;q=0.9, */*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": UA,
    };
    const cookie = jar.header(currentUrl);
    if (cookie) headers.Cookie = cookie;
    let body;
    if (currentForm) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(currentForm).toString();
    }
    const response = await fetchImpl(currentUrl, {
      method: currentMethod,
      headers,
      body,
      redirect: "manual",
      signal,
    });
    jar.capture(currentUrl, response);
    const text = await response.text();
    if (response.status < 300 || response.status > 399) {
      return { status: response.status, url: currentUrl, text };
    }
    const location = response.headers.get("location");
    if (!location) throw Object.assign(new Error(`redirect_${response.status}`), { code: "redirect" });
    const next = trustedXaiUrl(new URL(location, currentUrl).toString());
    if (!next) throw Object.assign(new Error("redirect_untrusted"), { code: "redirect_untrusted" });
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== "GET")) {
      currentMethod = "GET";
      currentForm = null;
    }
    currentUrl = next;
  }
  throw Object.assign(new Error("too_many_redirects"), { code: "too_many_redirects" });
}

async function convertLocal(ssoToken, fetchImpl, signal) {
  const jar = cookieJar();
  jar.seed(ssoToken);
  const accounts = await request(fetchImpl, jar, "GET", ACCOUNTS_URL, null, signal);
  if (accounts.status === 401 || /sign-in|sign-up/.test(accounts.url)) {
    throw Object.assign(new Error("sso_unauthorized"), { code: "sso_unauthorized" });
  }
  if (accounts.status < 200 || accounts.status >= 400) {
    throw Object.assign(new Error(`validate_sso_http_${accounts.status}`), { code: "sso_http" });
  }

  const deviceRes = await request(fetchImpl, jar, "POST", DEVICE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
  }, signal);
  if (deviceRes.status < 200 || deviceRes.status >= 300) {
    throw Object.assign(new Error(`device_http_${deviceRes.status}`), { code: "device_http" });
  }
  const device = JSON.parse(deviceRes.text || "{}");
  if (!device.device_code || !device.user_code || !trustedXaiUrl(device.verification_uri_complete || "")) {
    throw Object.assign(new Error("device_incomplete"), { code: "device_incomplete" });
  }
  const intervalMs = Math.max(1000, (Number(device.interval) || 5) * 1000);
  const expiresMs = Math.min((Number(device.expires_in) || 1800) * 1000, 75_000);

  const opened = await request(fetchImpl, jar, "GET", device.verification_uri_complete, null, signal);
  if (opened.status < 200 || opened.status >= 400) {
    throw Object.assign(new Error(`verify_open_http_${opened.status}`), { code: "verify_open" });
  }
  const verified = await request(fetchImpl, jar, "POST", VERIFY_URL, { user_code: device.user_code }, signal);
  if (verified.status < 200 || verified.status >= 400 || !String(verified.url).includes("consent")) {
    throw Object.assign(new Error("verify_no_consent"), { code: "verify_no_consent" });
  }
  const approved = await request(fetchImpl, jar, "POST", APPROVE_URL, {
    user_code: device.user_code,
    action: "allow",
    principal_type: "User",
    principal_id: "",
  }, signal);
  if (approved.status < 200 || approved.status >= 400 || !String(approved.url).includes("done")) {
    throw Object.assign(new Error("approve_not_done"), { code: "approve_not_done" });
  }

  const deadline = Date.now() + expiresMs;
  let wait = intervalMs;
  while (Date.now() < deadline) {
    await sleep(wait, signal);
    const tokenRes = await request(fetchImpl, jar, "POST", TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: device.device_code,
    }, signal);
    const payload = JSON.parse(tokenRes.text || "{}");
    if (tokenRes.status >= 200 && tokenRes.status < 300 && payload.access_token) {
      return {
        access: payload.access_token,
        refresh: payload.refresh_token || "",
        idToken: payload.id_token || "",
        expiresIn: Number(payload.expires_in) || DEFAULT_TTL_SEC,
      };
    }
    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") { wait += 5000; continue; }
    if (payload.error === "access_denied" || payload.error === "expired_token") {
      throw Object.assign(new Error(payload.error), { code: "authorization_denied" });
    }
    throw Object.assign(new Error(payload.error || `token_http_${tokenRes.status}`), { code: "token_poll" });
  }
  throw Object.assign(new Error("token_timeout"), { code: "token_timeout" });
}

async function fetchUserinfo(fetchImpl, access) {
  try {
    const res = await fetchImpl(USERINFO_URL, {
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json", "User-Agent": UA },
    });
    const data = await res.json().catch(() => ({}));
    return {
      email: firstEmail(data.email, data.preferred_username),
      name: typeof data.name === "string" ? data.name.trim() : "",
    };
  } catch {
    return { email: "", name: "" };
  }
}

function buildCredential(converted, info) {
  const credential = {
    type: "oauth",
    access: converted.access,
    refresh: converted.refresh,
    expires: Date.now() + (Number(converted.expiresIn) || DEFAULT_TTL_SEC) * 1000,
    tokenEndpoint: TOKEN_URL,
  };
  if (converted.idToken) credential.idToken = converted.idToken;
  if (info.email) credential.email = info.email;
  if (info.name) credential.name = info.name;
  return credential;
}

function safeStem(email, index) {
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : "";
  const cleaned = local.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || `account-${index + 1}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) fail("bad_args", "--out directory is required");
  const tokens = readTokens(args);
  if (tokens.length === 0) fail("no_tokens", "no SSO tokens from --file or --token-env");

  const fetchImpl = await makeFetch(args.proxy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const results = [];
  const bundleAccounts = [];
  try {
    fs.mkdirSync(args.out, { recursive: true });
    for (const [index, token] of tokens.entries()) {
      try {
        const converted = await convertLocal(token, fetchImpl, controller.signal);
        if (!converted.refresh) {
          results.push({ index, ok: false, code: "missing_refresh" });
          continue;
        }
        const info = await fetchUserinfo(fetchImpl, converted.access);
        const credential = buildCredential(converted, info);
        const file = path.join(args.out, `xai-oauth.${safeStem(info.email, index)}.json`);
        writeJson(file, credential);
        bundleAccounts.push({ email: info.email || null, credential });
        results.push({
          index,
          ok: true,
          email: info.email || null,
          file,
          provider: "xai-oauth",
        });
      } catch (err) {
        results.push({
          index,
          ok: false,
          code: err?.code || "convert_failed",
          message: err instanceof Error ? err.message : "convert_failed",
        });
      }
    }
    let bundle = null;
    if (args.bundle && bundleAccounts.length > 0) {
      bundle = path.join(args.out, "hana-oauth-bundle.json");
      writeJson(bundle, {
        version: 1,
        kind: "hana-oauth-bundle",
        provider: "xai-oauth",
        accounts: bundleAccounts,
      });
    }
    console.log(JSON.stringify({
      ok: results.every((item) => item.ok),
      provider: "xai-oauth",
      out: path.resolve(args.out),
      converted: results,
      bundle,
    }));
    if (!results.every((item) => item.ok)) process.exit(2);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  fail(err?.code || "crash", err instanceof Error ? err.message : "crash");
});
