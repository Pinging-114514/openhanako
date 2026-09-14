#!/usr/bin/env node
/**
 * Convert Grok Web SSO cookies into Build OAuth and upsert ~/.hanako oauth vault.
 * Never prints cookies or tokens.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
const AUTH_KEY = "xai-oauth";
const VAULT_NAME = "oauth-accounts.json";
const DEFAULT_TTL_SEC = 6 * 60 * 60;

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, code, message }));
  process.exit(1);
}

function parseArgs(argv) {
  const files = [];
  const tokenEnvs = [];
  let converter = "auto";
  let activate = false;
  let hanakoHome = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  let proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--file" && next) { files.push(next); i++; continue; }
    if (arg === "--token-env" && next) { tokenEnvs.push(next); i++; continue; }
    if (arg === "--converter" && next) { converter = next; i++; continue; }
    if (arg === "--hanako-home" && next) { hanakoHome = next; i++; continue; }
    if (arg === "--proxy" && next) { proxy = next; i++; continue; }
    if (arg === "--activate") { activate = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log("usage: import-grok-sso.mjs --file ticket.txt [--file more.txt] [--token-env NAME] [--converter auto|local|sub2api] [--activate]");
      process.exit(0);
    }
    fail("bad_args", `unknown argument: ${arg}`);
  }
  return { files, tokenEnvs, converter, activate, hanakoHome, proxy };
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
  if (!token || token.length > 16 * 1024) return "";
  return token;
}

function readTokens({ files, tokenEnvs }) {
  const tokens = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
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

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
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
  function hostKey(host) {
    return String(host || "").toLowerCase();
  }
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
      const host = hostKey(new URL(url).hostname);
      const bag = byHost.get(host) || new Map();
      const header = response.headers.getSetCookie?.() || [];
      for (const raw of header) {
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
      const host = hostKey(new URL(url).hostname);
      const bag = byHost.get(host);
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
  if (!currentUrl) throw new Error("untrusted_url");
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
    if (!location) throw new Error(`redirect_missing_location_${response.status}`);
    const next = trustedXaiUrl(new URL(location, currentUrl).toString());
    if (!next) throw new Error("redirect_untrusted");
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== "GET")) {
      currentMethod = "GET";
      currentForm = null;
    }
    currentUrl = next;
  }
  throw new Error("too_many_redirects");
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

async function convertSub2api(ssoToken) {
  const base = (process.env.SUB2API_BASE || "https://sub2api.vibelearning.top").replace(/\/$/, "");
  const email = process.env.SUB2API_EMAIL || "";
  const password = process.env.SUB2API_PASSWORD || "";
  if (!email || !password) {
    throw Object.assign(new Error("sub2api_credentials_missing"), { code: "sub2api_credentials_missing" });
  }
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ email, password }),
  });
  const loginData = await login.json().catch(() => ({}));
  const access = loginData?.data?.access_token;
  if (!access) {
    throw Object.assign(new Error(loginData?.message || "sub2api_login_failed"), { code: "sub2api_login" });
  }
  const res = await fetch(`${base}/api/v1/admin/grok/oauth/sso-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Authorization: `Bearer ${access}`,
    },
    body: JSON.stringify({ sso_token: ssoToken }),
  });
  const data = await res.json().catch(() => ({}));
  const info = data?.data && typeof data.data === "object" ? data.data : {};
  if (!res.ok || data?.code !== 0 || !info.access_token || !info.refresh_token) {
    throw Object.assign(new Error(data?.message || `sub2api_http_${res.status}`), { code: "sub2api_convert" });
  }
  return {
    access: info.access_token,
    refresh: info.refresh_token,
    idToken: info.id_token || "",
    expiresIn: Number(info.expires_in) || DEFAULT_TTL_SEC,
    email: firstEmail(info.email),
    name: typeof info.name === "string" ? info.name : "",
  };
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

async function convertOne(token, converter, fetchImpl, signal) {
  const tryLocal = converter === "auto" || converter === "local";
  const trySub = converter === "auto" || converter === "sub2api";
  let lastErr = null;
  if (tryLocal) {
    try {
      const tokens = await convertLocal(token, fetchImpl, signal);
      const info = await fetchUserinfo(fetchImpl, tokens.access);
      return { ...tokens, email: info.email, name: info.name, via: "local" };
    } catch (err) {
      lastErr = err;
      if (converter === "local") throw err;
    }
  }
  if (trySub) {
    try {
      const tokens = await convertSub2api(token);
      return { ...tokens, via: "sub2api" };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("convert_failed");
}

function inspectCredential(cred) {
  const access = decodeJwtPayload(cred.access) || {};
  const idToken = decodeJwtPayload(cred.idToken) || {};
  const accountId = String(access.sub || idToken.sub || cred.accountId || "").trim();
  const email = firstEmail(cred.email, access.email, idToken.email);
  const matchKey = accountId || email || `tok:${String(cred.refresh || cred.access).slice(-16)}`;
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : "";
  return {
    accountId,
    email,
    displayName: email || "Grok",
    shortLabel: (local || "Grok").slice(0, 12),
    matchKey,
  };
}

function emptyVault() {
  return { version: 1, providers: {} };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function upsertVault(vault, cred, { activate }) {
  const identity = inspectCredential(cred);
  const now = new Date().toISOString();
  const providers = vault.providers && typeof vault.providers === "object" ? vault.providers : {};
  const provider = providers[AUTH_KEY] && typeof providers[AUTH_KEY] === "object"
    ? providers[AUTH_KEY]
    : { activeId: null, profiles: [] };
  const profiles = Array.isArray(provider.profiles) ? [...provider.profiles] : [];
  const existing = profiles.find((item) => item.matchKey === identity.matchKey);
  const profile = {
    id: existing?.id || crypto.randomUUID(),
    matchKey: identity.matchKey,
    accountId: identity.accountId || existing?.accountId || "",
    email: identity.email || existing?.email || "",
    displayName: identity.displayName,
    shortLabel: identity.shortLabel,
    credential: cred,
    usage: existing?.usage ?? null,
    updatedAt: now,
  };
  const nextProfiles = [profile, ...profiles.filter((item) => item.id !== profile.id)];
  const activeId = activate
    ? profile.id
    : (provider.activeId && nextProfiles.some((item) => item.id === provider.activeId)
      ? provider.activeId
      : (provider.activeId || profile.id));
  return {
    vault: {
      version: 1,
      providers: { ...providers, [AUTH_KEY]: { activeId, profiles: nextProfiles } },
    },
    profile,
    becameActive: activeId === profile.id,
  };
}

function buildCredential(converted) {
  const cred = {
    type: "oauth",
    access: converted.access,
    refresh: converted.refresh,
    expires: Date.now() + (Number(converted.expiresIn) || DEFAULT_TTL_SEC) * 1000,
    tokenEndpoint: TOKEN_URL,
  };
  if (converted.idToken) cred.idToken = converted.idToken;
  if (converted.email) cred.email = converted.email;
  if (converted.name) cred.name = converted.name;
  return cred;
}

async function refreshHana(hanakoHome) {
  const infoPath = path.join(hanakoHome, "server-info.json");
  if (!fs.existsSync(infoPath)) return { refreshed: false, reason: "hana_not_running" };
  const info = readJson(infoPath, null);
  const port = Number(info?.port);
  const token = typeof info?.token === "string" ? info.token : "";
  if (!port || !token) return { refreshed: false, reason: "server_info_incomplete" };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/oauth/${AUTH_KEY}/accounts?refresh=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    const accounts = Array.isArray(data.accounts) ? data.accounts.map((item) => ({
      email: item.email || "",
      active: !!item.active,
    })) : [];
    return { refreshed: res.ok, status: res.status, accounts };
  } catch {
    return { refreshed: false, reason: "hana_refresh_failed" };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["auto", "local", "sub2api"].includes(args.converter)) {
    fail("bad_args", "converter must be auto, local, or sub2api");
  }
  const tokens = readTokens(args);
  if (tokens.length === 0) fail("no_tokens", "no SSO tokens from --file or --token-env");

  const fetchImpl = await makeFetch(args.proxy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const imported = [];
  try {
    let vault = readJson(path.join(args.hanakoHome, VAULT_NAME), emptyVault());
    for (const [index, token] of tokens.entries()) {
      try {
        const converted = await convertOne(token, args.converter, fetchImpl, controller.signal);
        if (!converted.refresh) {
          imported.push({ index, ok: false, code: "missing_refresh" });
          continue;
        }
        const cred = buildCredential(converted);
        const result = upsertVault(vault, cred, { activate: args.activate && index === tokens.length - 1 });
        vault = result.vault;
        imported.push({
          index,
          ok: true,
          email: result.profile.email || null,
          via: converted.via,
          updated: true,
          active: result.becameActive,
        });
      } catch (err) {
        imported.push({
          index,
          ok: false,
          code: err?.code || "convert_failed",
          message: err instanceof Error ? err.message : "convert_failed",
        });
      }
    }
    writeJson(path.join(args.hanakoHome, VAULT_NAME), vault);

    if (args.activate) {
      const provider = vault.providers[AUTH_KEY];
      const active = provider?.profiles?.find((item) => item.id === provider.activeId);
      if (active?.credential) {
        const authPath = path.join(args.hanakoHome, "auth.json");
        const auth = readJson(authPath, {});
        auth[AUTH_KEY] = { ...active.credential, type: "oauth" };
        writeJson(authPath, auth);
      }
    }

    const hana = await refreshHana(args.hanakoHome);
    console.log(JSON.stringify({
      ok: imported.every((item) => item.ok),
      imported,
      hana,
    }));
    if (!imported.every((item) => item.ok)) process.exit(2);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  fail(err?.code || "crash", err instanceof Error ? err.message : "crash");
});
