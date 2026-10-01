import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateOauthAccount,
  listCachedOauthAccounts,
  listOauthAccounts,
  readOauthAccountVault,
  refreshOauthAccountUsages,
  removeStoredOauthAccount,
} from "../lib/auth/oauth-account-vault.ts";
import { xaiOAuthProvider } from "../lib/auth/xai-oauth.ts";

const dirs: string[] = [];

function jwt(payload: object) {
  return `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function credential(id: string, version = "old", expires = Date.now() + 3_600_000) {
  return {
    type: "oauth",
    accountId: id,
    email: `${id}@example.invalid`,
    refresh: `fake-refresh-${id}-${version}`,
    access: jwt({
      sub: id,
      email: `${id}@example.invalid`,
      version,
      "https://api.openai.com/auth": { chatgpt_account_id: id },
    }),
    expires,
  };
}

function engineFor(key: string, initial: Record<string, any>) {
  const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-oauth-race-"));
  dirs.push(hanakoHome);
  let slot: Record<string, any> | null = { ...initial };
  return {
    hanakoHome,
    setSlot(next: Record<string, any> | null) { slot = next; },
    authStorage: {
      get: (k: string) => (k === key ? slot : null),
      reload: vi.fn(),
      logout: vi.fn(async () => { slot = null; }),
      credentials: {
        modify: vi.fn(async (_k: string, fn: (current: unknown) => unknown) => {
          slot = await fn(slot) as Record<string, any> | null;
          return slot;
        }),
      },
    },
    providerRegistry: {
      getAuthJsonKey: (k: string) => k,
      clearAuthCache: vi.fn(),
    },
    onProviderChanged: vi.fn(async () => {}),
  };
}

async function seedTwo(
  engine: ReturnType<typeof engineFor>,
  key: string,
  a: ReturnType<typeof credential>,
  b: ReturnType<typeof credential>,
) {
  await listOauthAccounts(engine, key);
  engine.setSlot(b);
  await listOauthAccounts(engine, key);
  engine.setSlot(a);
  return listOauthAccounts(engine, key);
}

function delayedUsage() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    if (++calls === 1) await gate;
    return new Response(JSON.stringify({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { release, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("oauth vault races", () => {
  it("does not resurrect an account deleted during usage refresh", async () => {
    const key = "openai-codex";
    const a = credential("audit-a");
    const b = credential("audit-b");
    const engine = engineFor(key, a);
    const accounts = await seedTwo(engine, key, a, b);
    const bId = accounts.find(item => item.email === b.email)!.id;
    const { release, fetchMock } = delayedUsage();
    const running = refreshOauthAccountUsages(engine, key);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const deleting = removeStoredOauthAccount(engine, key, bId);
    await vi.waitFor(() => expect(listCachedOauthAccounts(engine, key).some(item => item.id === bId)).toBe(false));
    release();
    await Promise.all([running, deleting]);
    expect(listCachedOauthAccounts(engine, key).some(item => item.id === bId)).toBe(false);
  });

  it("keeps the newly activated Grok slot when an older refresh token rotates", async () => {
    const key = "xai-oauth";
    const a = { ...credential("audit-a"), expires: Date.now() - 1 };
    const b = credential("audit-b");
    const engine = engineFor(key, a);
    const accounts = await seedTwo(engine, key, a, b);
    const bId = accounts.find(item => item.email === b.email)!.id;
    const rotated = credential("audit-a", "rotated");
    vi.spyOn(xaiOAuthProvider, "refreshToken").mockResolvedValue(rotated as never);
    const { release, fetchMock } = delayedUsage();
    const running = refreshOauthAccountUsages(engine, key);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const switching = activateOauthAccount(engine, key, bId);
    await vi.waitFor(() => expect(engine.authStorage.get(key)?.accountId).toBe("audit-b"));
    release();
    await Promise.all([running, switching]);
    expect(engine.authStorage.get(key)?.accountId).toBe("audit-b");
    expect(engine.authStorage.get(key)?.access).not.toBe(rotated.access);
    const savedA = readOauthAccountVault(engine.hanakoHome).providers[key]?.profiles
      .find(item => item.email === a.email);
    expect(savedA?.credential.access).toBe(rotated.access);
    expect(savedA?.credential.refresh).toBe(rotated.refresh);
  });

  it("reads Codex usage with the live access token instead of a stale vault copy", async () => {
    const key = "openai-codex";
    const old = { ...credential("audit-a", "old"), expires: Date.now() - 1 };
    const fresh = credential("audit-a", "fresh");
    const engine = engineFor(key, old);
    await listOauthAccounts(engine, key);
    engine.setSlot(fresh);
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { headers?: HeadersInit }) => {
      const auth = new Headers(init?.headers).get("authorization") || "";
      authorizations.push(auth);
      return auth === `Bearer ${fresh.access}`
        ? new Response(JSON.stringify({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
        }), { status: 200 })
        : new Response("expired test access token", { status: 401 });
    }));
    await refreshOauthAccountUsages(engine, key);
    expect(authorizations).toContain(`Bearer ${fresh.access}`);
    expect(authorizations).not.toContain(`Bearer ${old.access}`);
    expect(engine.authStorage.get(key)?.access).toBe(fresh.access);
    expect(JSON.stringify(listCachedOauthAccounts(engine, key))).not.toContain("auth_revoked");
  });

  it("does not mark a non-active expired Codex token as revoked", async () => {
    const key = "openai-codex";
    const live = credential("audit-a", "fresh");
    const stale = { ...credential("audit-b", "old"), expires: Date.now() - 1 };
    const engine = engineFor(key, live);
    await listOauthAccounts(engine, key);
    engine.setSlot(stale);
    await listOauthAccounts(engine, key);
    engine.setSlot(live);
    await listOauthAccounts(engine, key);
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { headers?: HeadersInit }) => {
      const auth = new Headers(init?.headers).get("authorization") || "";
      authorizations.push(auth);
      return new Response(JSON.stringify({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
      }), { status: 200 });
    }));
    await refreshOauthAccountUsages(engine, key);
    expect(authorizations).toEqual([`Bearer ${live.access}`]);
    const cached = listCachedOauthAccounts(engine, key);
    expect(cached.find(item => item.email === stale.email)?.usage?.error ?? null).not.toBe("auth_revoked");
    expect(JSON.stringify(cached)).not.toContain("auth_revoked");
  });

  it("does not overwrite a newer Pi slot token or revoke an expired idle account", async () => {
    const key = "xai-oauth";
    const stale = { ...credential("audit-a", "stale"), expires: Date.now() - 1 };
    const idle = { ...credential("audit-b", "idle"), expires: Date.now() - 1 };
    const engine = engineFor(key, stale);
    await seedTwo(engine, key, stale, idle);
    const newer = credential("audit-a", "pi-newer");
    const rotated = credential("audit-a", "vault-rotated");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refreshedAccounts: string[] = [];
    vi.spyOn(xaiOAuthProvider, "refreshToken").mockImplementation(async (cred) => {
      const accountId = String(cred.accountId || "");
      refreshedAccounts.push(accountId);
      if (accountId === "audit-b") throw new Error("idle refresh is not a revocation");
      await gate;
      return rotated;
    });
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { headers?: HeadersInit }) => {
      const auth = new Headers(init?.headers).get("authorization") || "";
      authorizations.push(auth);
      if (auth === `Bearer ${newer.access}`) {
        return new Response(JSON.stringify({
          config: { creditUsagePercent: 10, currentPeriod: { end: "2026-08-23T04:00:00.000Z" } },
        }), { status: 200 });
      }
      return new Response("expired test access token", { status: 401 });
    }));
    const running = refreshOauthAccountUsages(engine, key);
    await vi.waitFor(() => expect(xaiOAuthProvider.refreshToken).toHaveBeenCalled());
    engine.setSlot(newer);
    release();
    await running;
    expect(engine.authStorage.get(key)?.access).toBe(newer.access);
    expect(engine.authStorage.get(key)?.refresh).toBe(newer.refresh);
    expect(engine.authStorage.get(key)?.access).not.toBe(rotated.access);
    expect(authorizations.some(header => header === `Bearer ${idle.access}`)).toBe(false);
    const cached = listCachedOauthAccounts(engine, key);
    expect(cached.find(item => item.email === idle.email)?.usage?.error ?? null).not.toBe("auth_revoked");
    expect(JSON.stringify(cached)).not.toContain("auth_revoked");
    expect(refreshedAccounts).toContain("audit-a");
  });
});