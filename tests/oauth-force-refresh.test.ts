import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AuthStorage, createModelRuntime } from "../lib/pi-sdk/index.ts";
import { PiAuthStore } from "../lib/pi-sdk/auth-store.ts";
import { forceRefreshOAuthApiKey } from "../core/oauth-force-refresh.ts";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const AUTH_KEY = "openai-codex";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * The refresh path decodes the new access token as a JWT and reads the ChatGPT
 * account id out of it, so a mocked token response has to carry a real-looking
 * payload segment.
 */
function codexJwt(accountId) {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64");
  return `header.${payload}.signature`;
}

function tokenResponse({ access, refresh, expiresIn = 3600 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: access,
      refresh_token: refresh,
      expires_in: expiresIn,
      id_token: codexJwt("acct_id_token"),
    }),
  };
}

/** Nine days out: far from expiry as far as the local record is concerned. */
function futureExpiry() {
  return Date.now() + 9 * 24 * 3600 * 1000;
}

function seedData(access = "stale-A"): Record<string, any> {
  return {
    [AUTH_KEY]: {
      type: "oauth",
      access,
      refresh: "r1",
      expires: futureExpiry(),
      accountId: "acct_seed",
    },
  };
}

describe("forceRefreshOAuthApiKey", () => {
  let tmpDir;
  let authPath;

  beforeEach(() => {
    mockFetch.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-force-refresh-"));
    authPath = path.join(tmpDir, "auth.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A real ModelRuntime over a throwaway auth.json: the rotation has to go
   * through pi's own openai-codex OAuth adapter and the store's file lock, the
   * same path production uses.
   */
  async function storeWithRaw(raw: string) {
    fs.writeFileSync(authPath, raw, "utf-8");
    const credentials = AuthStorage.create(authPath);
    const runtime = await createModelRuntime({
      credentials,
      authPath,
      modelsJsonPath: path.join(tmpDir, "models.json"),
    });
    return new PiAuthStore({ credentials, authPath, runtime });
  }

  function storeWith(data: Record<string, any> = seedData()) {
    return storeWithRaw(JSON.stringify(data, null, 2));
  }

  function storedCred(store: PiAuthStore): any {
    return store.get(AUTH_KEY);
  }

  it("rotates the credential even though the local record is not expired yet", async () => {
    const store = await storeWith();
    expect(storedCred(store).expires).toBeGreaterThan(Date.now());

    const rotated = codexJwt("acct_new");
    mockFetch.mockResolvedValueOnce(tokenResponse({ access: rotated, refresh: "r2" }));

    const apiKey = await forceRefreshOAuthApiKey({
      authStore: store,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(apiKey).toBe(rotated);

    const stored = storedCred(store);
    expect(stored.type).toBe("oauth");
    expect(stored.access).toBe(rotated);
    expect(stored.refresh).toBe("r2");
    expect(stored.accountId).toBe("acct_new");
  });

  it("skips the network call when the stored credential was already rotated", async () => {
    const store = await storeWith(seedData("B"));

    const apiKey = await forceRefreshOAuthApiKey({
      authStore: store,
      authKey: AUTH_KEY,
      staleApiKey: "A",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(apiKey).toBe("B");
    expect(storedCred(store).access).toBe("B");
    expect(storedCred(store).refresh).toBe("r1");
  });

  it("leaves the stored credential untouched when the refresh call fails", async () => {
    const store = await storeWith();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => JSON.stringify({ error: "invalid_grant" }),
      json: async () => ({ error: "invalid_grant" }),
    });

    await expect(forceRefreshOAuthApiKey({
      authStore: store,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const stored = storedCred(store);
    expect(stored.access).toBe("stale-A");
    expect(stored.refresh).toBe("r1");
  });

  it("rejects without any network call when the entry is missing or not an OAuth credential", async () => {
    const missing = await storeWith({});
    await expect(forceRefreshOAuthApiKey({
      authStore: missing,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow(/no OAuth credential stored/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-force-refresh-"));
    authPath = path.join(tmpDir, "auth.json");
    const wrongType = await storeWith({
      [AUTH_KEY]: { type: "api_key", key: "sk-test" },
    });
    await expect(forceRefreshOAuthApiKey({
      authStore: wrongType,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow(/no OAuth credential stored/);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes exactly once when two callers race on the same stale credential", async () => {
    const store = await storeWith();

    const rotated = codexJwt("acct_race");
    mockFetch.mockImplementation(async () => tokenResponse({ access: rotated, refresh: "r2" }));

    const call = () => forceRefreshOAuthApiKey({
      authStore: store,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    });
    const [first, second] = await Promise.all([call(), call()]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(first).toBe(rotated);
    expect(second).toBe(rotated);
    expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))[AUTH_KEY].access).toBe(rotated);
  });

  it("rejects without any network call when the stored credentials are unreadable", async () => {
    const store = await storeWithRaw("{not json");

    await expect(forceRefreshOAuthApiKey({
      authStore: store,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(authPath, "utf-8")).toBe("{not json");
  });

  it("rejects when no auth store is available", async () => {
    await expect(forceRefreshOAuthApiKey({
      authStore: null,
      authKey: AUTH_KEY,
    })).rejects.toThrow(/auth storage unavailable/);
  });
});
