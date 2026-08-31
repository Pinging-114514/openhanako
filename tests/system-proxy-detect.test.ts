import { describe, expect, it, vi } from "vitest";
import {
  currentEnvProxyFingerprint,
  fingerprintSystemProxy,
  parseMacScutilProxy,
  parsePacFirstHop,
  parseWindowsInternetSettings,
  stampDetectedProxyEnv,
  urlsFromWindowsProxyServer,
} from "../lib/net/system-proxy-detect.ts";
import { startSystemProxySync } from "../lib/net/system-proxy-sync.ts";

describe("system proxy detect", () => {
  it("parses a simple Windows ProxyServer host:port", () => {
    expect(urlsFromWindowsProxyServer("127.0.0.1:7890")).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      socksProxy: "",
    });
  });

  it("parses protocol-specific Windows ProxyServer lists", () => {
    expect(urlsFromWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891")).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      socksProxy: "socks5://127.0.0.1:7891",
    });
  });

  it("reads ProxyEnable from reg.exe output", () => {
    const parsed = parseWindowsInternetSettings(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    AutoConfigURL    REG_SZ    http://127.0.0.1:7890/pac
`);
    expect(parsed).toEqual({
      enabled: true,
      server: "127.0.0.1:7890",
      autoConfigUrl: "http://127.0.0.1:7890/pac",
    });
  });

  it("parses macOS scutil --proxy output", () => {
    expect(parseMacScutilProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
  SOCKSEnable : 0
}
`)).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      socksProxy: "",
    });
  });

  it("parses the first hop out of a Clash PAC", () => {
    expect(parsePacFirstHop('return "PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:7891; DIRECT";')).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      socksProxy: "",
    });
  });

  it("stamps and clears process env from a detected proxy", () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: "http://old:1" };
    stampDetectedProxyEnv({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      socksProxy: "",
    }, env);
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    stampDetectedProxyEnv({ httpProxy: "", httpsProxy: "", socksProxy: "" }, env);
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(currentEnvProxyFingerprint(env)).toBe(fingerprintSystemProxy({
      httpProxy: "",
      httpsProxy: "",
      socksProxy: "",
    }));
  });
});

describe("system proxy sync", () => {
  it("applies when OS proxy appears after boot with empty env", async () => {
    const env: Record<string, string | undefined> = {};
    const applied: string[] = [];
    const syncer = startSystemProxySync({
      getMode: () => "system",
      apply: (config) => applied.push(config.mode),
      env,
      intervalMs: 60_000,
      detect: async () => ({
        httpProxy: "http://127.0.0.1:7890",
        httpsProxy: "http://127.0.0.1:7890",
        socksProxy: "",
      }),
    });
    await vi.waitFor(() => {
      expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    });
    expect(applied).toEqual(["system"]);
    await expect(syncer.sync()).resolves.toBe(false);
    syncer.stop();
  });
});
