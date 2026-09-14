import { Readable } from "stream";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createOtaFetchOnce,
  createProxiedFetch,
  isProxyConnectError,
} = require("../desktop/src/shared/ota-proxied-fetch.cjs");

function okResponse(body = "") {
  return {
    statusCode: 200,
    headers: { etag: '"x"' },
    bodyStream: Readable.from([Buffer.from(body)]),
  };
}

describe("ota-proxied-fetch: Electron net", () => {
  it("sends the request through Electron net with the session and follows redirects there", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeNet = {
      request(opts: Record<string, unknown>) {
        calls.push(opts);
        const listeners: Record<string, Function> = {};
        const req = {
          setHeader() {},
          on(event: string, fn: Function) {
            listeners[event] = fn;
            return req;
          },
          abort() {},
          end() {
            const response = Readable.from([Buffer.from("ok")]) as Readable & {
              statusCode: number;
              headers: Record<string, string>;
            };
            response.statusCode = 200;
            response.headers = { ETag: '"abc"' };
            listeners.response(response);
          },
        };
        return req;
      },
    };

    const fetchOnce = createOtaFetchOnce({
      electronNet: fakeNet,
      getSession: () => ({ id: "default" }),
      getProxyUrl: async () => {
        throw new Error("Node proxy resolve must not run when Electron net is used");
      },
    });
    const res = await fetchOnce("https://github.com/Pinging-114514/openhanako/releases/download/channels/stable.json");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].redirect).toBe("follow");
    expect(calls[0].session).toEqual({ id: "default" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"abc"');
  });
});

describe("ota-proxied-fetch: Node fallback", () => {
  it("pins the first resolved proxy so a later DIRECT hop still uses the agent", async () => {
    const seen: boolean[] = [];
    let n = 0;
    const fetchOnce = createOtaFetchOnce({
      getProxyUrl: async () => (++n === 1 ? "http://127.0.0.1:10810" : ""),
      requestImpl: async (_url: string, opts: { agent?: unknown }) => {
        seen.push(Boolean(opts.agent));
        return okResponse();
      },
    });
    await fetchOnce("https://github.com/example/stable.json");
    await fetchOnce("https://release-assets.githubusercontent.com/asset");
    expect(seen).toEqual([true, true]);
  });

  it("rebuilds a dead ProxyAgent after ECONNREFUSED instead of going direct", async () => {
    let n = 0;
    const agents: unknown[] = [];
    const fetchOnce = createOtaFetchOnce({
      getProxyUrl: async () => "http://127.0.0.1:10810",
      requestImpl: async (_url: string, opts: { agent?: unknown }) => {
        n += 1;
        agents.push(opts.agent);
        if (n === 1) {
          const err = new Error("connect ECONNREFUSED 127.0.0.1:10810");
          (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
          throw err;
        }
        return okResponse("ok");
      },
    });
    const res = await fetchOnce("https://github.com/example/stable.json");
    expect(res.statusCode).toBe(200);
    expect(n).toBe(2);
    expect(agents[0]).toBeTruthy();
    expect(agents[1]).toBeTruthy();
    expect(agents[1]).not.toBe(agents[0]);
  });

  it("does not attach an agent when no proxy was ever resolved", async () => {
    let sawAgent = false;
    const fetchOnce = createOtaFetchOnce({
      getProxyUrl: async () => "",
      requestImpl: async (_url: string, opts: { agent?: unknown }) => {
        sawAgent = Boolean(opts.agent);
        return okResponse();
      },
    });
    await fetchOnce("https://github.com/example/stable.json");
    expect(sawAgent).toBe(false);
  });
});

describe("ota-proxied-fetch: createProxiedFetch", () => {
  it("follows a 302 to the GitHub release-asset CDN on the Node path", async () => {
    const urls: string[] = [];
    const fetch = createProxiedFetch({
      getProxyUrl: async () => "http://127.0.0.1:10810",
      requestImpl: async (url: string, opts: { agent?: unknown }) => {
        urls.push(url);
        expect(opts.agent).toBeTruthy();
        if (url.includes("github.com")) {
          return {
            statusCode: 302,
            headers: { location: "https://release-assets.githubusercontent.com/stable.json" },
            bodyStream: Readable.from([]),
          };
        }
        return okResponse('{"ok":true}');
      },
    });
    const res = await fetch("https://github.com/Pinging-114514/openhanako/releases/download/channels/stable.json");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
    expect(urls[1]).toContain("release-assets.githubusercontent.com");
  });
});

describe("ota-proxied-fetch: isProxyConnectError", () => {
  it("treats ECONNREFUSED as a proxy connect failure", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:10810");
    (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
    expect(isProxyConnectError(err)).toBe(true);
  });
});
