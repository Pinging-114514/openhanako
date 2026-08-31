import { execFileSync } from "node:child_process";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "WS_PROXY",
  "ws_proxy",
  "WSS_PROXY",
  "wss_proxy",
  "ALL_PROXY",
  "all_proxy",
];

export type DetectedSystemProxy = {
  httpProxy: string;
  httpsProxy: string;
  socksProxy: string;
};

export function emptySystemProxy(): DetectedSystemProxy {
  return { httpProxy: "", httpsProxy: "", socksProxy: "" };
}

export function fingerprintSystemProxy(detected: DetectedSystemProxy | null | undefined): string {
  const value = detected || emptySystemProxy();
  return [value.httpsProxy || "", value.httpProxy || "", value.socksProxy || ""].join("|");
}

function withScheme(raw: string, fallbackScheme: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.replace(/\/$/, "");
  return `${fallbackScheme}://${value}`;
}

export function urlsFromWindowsProxyServer(server: string): DetectedSystemProxy {
  const raw = String(server || "").trim();
  const detected = emptySystemProxy();
  if (!raw) return detected;

  if (!raw.includes("=") && !raw.includes(";")) {
    const url = withScheme(raw, "http");
    detected.httpProxy = url;
    detected.httpsProxy = url;
    return detected;
  }

  for (const part of raw.split(";")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) {
      const url = withScheme(item, "http");
      detected.httpProxy = detected.httpProxy || url;
      detected.httpsProxy = detected.httpsProxy || url;
      continue;
    }
    const kind = item.slice(0, eq).trim().toLowerCase();
    const value = item.slice(eq + 1).trim();
    if (!value) continue;
    if (kind === "https") detected.httpsProxy = withScheme(value, "http");
    else if (kind === "http") detected.httpProxy = withScheme(value, "http");
    else if (kind === "socks5" || kind === "socks") detected.socksProxy = withScheme(value, "socks5");
  }
  if (!detected.httpsProxy) detected.httpsProxy = detected.httpProxy;
  if (!detected.httpProxy) detected.httpProxy = detected.httpsProxy;
  return detected;
}

export function parseWindowsInternetSettings(text: string): {
  enabled: boolean;
  server: string;
  autoConfigUrl: string;
} {
  const values: Record<string, string> = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s+(\w+)\s+REG_\w+\s+(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim();
  }
  const enable = String(values.ProxyEnable || "").toLowerCase();
  return {
    enabled: enable === "0x1" || enable === "1",
    server: values.ProxyServer || "",
    autoConfigUrl: values.AutoConfigURL || "",
  };
}

export function parseMacScutilProxy(text: string): DetectedSystemProxy {
  const detected = emptySystemProxy();
  const body = String(text || "");
  const numberValue = (key: string) => {
    const match = body.match(new RegExp(`${key}\\s*:\\s*(\\d+)`, "i"));
    return match ? Number(match[1]) : 0;
  };
  const stringValue = (key: string) => {
    const match = body.match(new RegExp(`${key}\\s*:\\s*(\\S+)`, "i"));
    return match ? match[1] : "";
  };
  if (numberValue("HTTPSEnable") === 1 && stringValue("HTTPSProxy")) {
    detected.httpsProxy = `http://${stringValue("HTTPSProxy")}:${numberValue("HTTPSPort") || 443}`;
  }
  if (numberValue("HTTPEnable") === 1 && stringValue("HTTPProxy")) {
    detected.httpProxy = `http://${stringValue("HTTPProxy")}:${numberValue("HTTPPort") || 80}`;
  }
  if (numberValue("SOCKSEnable") === 1 && stringValue("SOCKSProxy")) {
    detected.socksProxy = `socks5://${stringValue("SOCKSProxy")}:${numberValue("SOCKSPort") || 1080}`;
  }
  if (!detected.httpsProxy) detected.httpsProxy = detected.httpProxy;
  if (!detected.httpProxy) detected.httpProxy = detected.httpsProxy;
  return detected;
}

export function parsePacFirstHop(pacText: string): DetectedSystemProxy {
  const detected = emptySystemProxy();
  const match = String(pacText || "").match(/\b(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s;";]+)/i);
  if (!match) return detected;
  const kind = match[1].toUpperCase();
  const server = match[2].trim();
  if (kind === "SOCKS5" || kind === "SOCKS") {
    detected.socksProxy = withScheme(server, "socks5");
    return detected;
  }
  const url = withScheme(server, "http");
  detected.httpProxy = url;
  detected.httpsProxy = url;
  return detected;
}

function isLocalPacUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]");
  } catch {
    return false;
  }
}

function queryWindowsInternetSettings(): string {
  return execFileSync("reg.exe", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  ], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });
}

function queryMacScutilProxy(): string {
  return execFileSync("scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 3000,
  });
}

export async function detectOsSystemProxy(options: {
  platform?: NodeJS.Platform;
  readWindowsSettings?: () => string;
  readMacSettings?: () => string;
  fetchPac?: (url: string) => Promise<string>;
} = {}): Promise<DetectedSystemProxy> {
  const platform = options.platform || process.platform;
  try {
    if (platform === "win32") {
      const settings = parseWindowsInternetSettings(
        (options.readWindowsSettings || queryWindowsInternetSettings)(),
      );
      if (settings.enabled && settings.server) {
        return urlsFromWindowsProxyServer(settings.server);
      }
      if (settings.autoConfigUrl && isLocalPacUrl(settings.autoConfigUrl)) {
        const fetchPac = options.fetchPac || (async (url: string) => {
          const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(2000) });
          return await response.text();
        });
        const pac = await fetchPac(settings.autoConfigUrl);
        return parsePacFirstHop(pac);
      }
      return emptySystemProxy();
    }
    if (platform === "darwin") {
      return parseMacScutilProxy((options.readMacSettings || queryMacScutilProxy)());
    }
  } catch {
    return emptySystemProxy();
  }
  return emptySystemProxy();
}

export function stampDetectedProxyEnv(detected: DetectedSystemProxy, env: Record<string, string | undefined> = process.env): DetectedSystemProxy {
  const httpProxy = detected.httpProxy || detected.httpsProxy || detected.socksProxy || "";
  const httpsProxy = detected.httpsProxy || detected.httpProxy || detected.socksProxy || "";
  for (const key of PROXY_ENV_KEYS) delete env[key];
  if (httpProxy) {
    env.HTTP_PROXY = env.http_proxy = httpProxy;
    env.ALL_PROXY = env.all_proxy = httpProxy;
  }
  if (httpsProxy) {
    env.HTTPS_PROXY = env.https_proxy = httpsProxy;
  }
  if (detected.socksProxy && !httpProxy && !httpsProxy) {
    env.ALL_PROXY = env.all_proxy = detected.socksProxy;
    env.HTTP_PROXY = env.http_proxy = detected.socksProxy;
    env.HTTPS_PROXY = env.https_proxy = detected.socksProxy;
  }
  return detected;
}

export function currentEnvProxyFingerprint(env: Record<string, string | undefined> = process.env): string {
  return fingerprintSystemProxy({
    httpProxy: env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || "",
    httpsProxy: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "",
    socksProxy: "",
  });
}
