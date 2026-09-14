import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateOauthAccount,
  emptyOauthAccountVault,
  listOauthAccounts,
  logoutActiveOauthAccount,
  publicOauthAccounts,
  refreshOauthAccountUsages,
  removeOauthAccount,
  upsertOauthCredential,
} from "../lib/auth/oauth-account-vault.ts";
import { xaiOAuthProvider } from "../lib/auth/xai-oauth.ts";

function jwtWith(payload: Record<string, unknown>): string {
  return `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function cred(accountId: string, email: string, access = "access") {
  return {
    type: "oauth",
    access: jwtWith({
      email,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
    refresh: `refresh-${accountId}`,
    accountId,
  };
}

const work = cred("acct-work", "work@example.com");
const home = cred("acct-home", "home@example.com");

describe("oauth account vault", () => {
  it("dedupes the same Codex account and keeps the previous one when a new login arrives", () => {
    const first = upsertOauthCredential(emptyOauthAccountVault(), "openai-codex", work);
    const second = upsertOauthCredential(first.vault, "openai-codex", {
      ...work,
      refresh: "refresh-work-rotated",
    });
    const third = upsertOauthCredential(second.vault, "openai-codex", home);

    expect(second.vault.providers["openai-codex"]?.profiles).toHaveLength(1);
    expect(second.profile.credential.refresh).toBe("refresh-work-rotated");
    expect(publicOauthAccounts(third.vault, "openai-codex")).toEqual([
      expect.objectContaining({ email: "home@example.com", active: true }),
      expect.objectContaining({ email: "work@example.com", active: false }),
    ]);
  });

  it("promotes the remaining account when the active one is removed", () => {
    let vault = upsertOauthCredential(emptyOauthAccountVault(), "openai-codex", work).vault;
    vault = upsertOauthCredential(vault, "openai-codex", home).vault;
    const activeId = vault.providers["openai-codex"]?.activeId || "";
    const removed = removeOauthAccount(vault, "openai-codex", activeId);

    expect(removed.nextActive?.email).toBe("work@example.com");
    expect(publicOauthAccounts(removed.vault, "openai-codex")).toEqual([
      expect.objectContaining({ email: "work@example.com", active: true }),
    ]);
  });

  it("does not show a Grok subject UUID as the account label", () => {
    const grok = {
      type: "oauth",
      access: jwtWith({ sub: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" }),
      refresh: "refresh-grok",
    };
    const { profile, vault } = upsertOauthCredential(emptyOauthAccountVault(), "xai-oauth", grok);
    expect(profile.email).toBe("");
    expect(profile.displayName).toBe("Grok");
    expect(profile.shortLabel).toBe("Grok");
    expect(publicOauthAccounts(vault, "xai-oauth")).toEqual([
      expect.objectContaining({
        email: "",
        displayName: "Grok",
        shortLabel: "Grok",
        accountId: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e",
      }),
    ]);
  });

  it("keeps a previously saved Grok email when the slot token has none", () => {
    const grok = {
      type: "oauth",
      access: jwtWith({ sub: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" }),
      refresh: "refresh-grok",
      email: "saved@x.ai",
    };
    const first = upsertOauthCredential(emptyOauthAccountVault(), "xai-oauth", grok);
    const second = upsertOauthCredential(first.vault, "xai-oauth", {
      type: "oauth",
      access: jwtWith({ sub: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" }),
      refresh: "refresh-grok-rotated",
    });
    expect(second.profile.email).toBe("saved@x.ai");
    expect(second.profile.displayName).toBe("saved@x.ai");
    expect(second.profile.credential.email).toBe("saved@x.ai");
  });
});

describe("oauth account vault engine wrappers", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeEngine(initial = work) {
    const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-oauth-vault-"));
    dirs.push(hanakoHome);
    let slot: Record<string, any> | null = { ...initial };
    return {
      hanakoHome,
      setSlot(next: Record<string, any> | null) { slot = next; },
      authStorage: {
        get: vi.fn((key: string) => (key === "openai-codex" ? slot : null)),
        reload: vi.fn(),
        logout: vi.fn(async () => { slot = null; }),
        credentials: {
          modify: vi.fn(async (_key: string, fn: (current: unknown) => unknown) => {
            slot = await fn(slot) as Record<string, any>;
            return slot;
          }),
        },
      },
      providerRegistry: {
        getAuthJsonKey: vi.fn((provider: string) => (
          provider === "openai-codex-oauth" ? "openai-codex" : provider
        )),
        clearAuthCache: vi.fn(),
      },
      onProviderChanged: vi.fn(async () => {}),
    };
  }

  it("lists both saved accounts and switches the Pi slot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
    }), { status: 200 })));
    const engine = makeEngine(work);
    await listOauthAccounts(engine, "openai-codex-oauth");
    engine.setSlot(home);
    const listed = await listOauthAccounts(engine, "openai-codex-oauth");
    expect(listed.map(item => item.email)).toEqual(["home@example.com", "work@example.com"]);

    const workId = listed.find(item => item.email === "work@example.com")?.id || "";
    await activateOauthAccount(engine, "openai-codex-oauth", workId);
    expect(engine.authStorage.credentials.modify).toHaveBeenCalled();
    expect(engine.authStorage.get("openai-codex").accountId).toBe("acct-work");
  });

  it("logout removes only the active account and keeps the other in the slot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } },
    }), { status: 200 })));
    const engine = makeEngine(work);
    await listOauthAccounts(engine, "openai-codex");
    engine.setSlot(home);
    await listOauthAccounts(engine, "openai-codex");

    const remaining = await logoutActiveOauthAccount(engine, "openai-codex");
    expect(remaining).toEqual([
      expect.objectContaining({ email: "work@example.com", active: true }),
    ]);
    expect(engine.authStorage.logout).not.toHaveBeenCalled();
    expect(engine.authStorage.get("openai-codex").accountId).toBe("acct-work");
  });

  it("fills a missing Grok email from userinfo when refreshing the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/oauth2/userinfo")) {
        return new Response(JSON.stringify({ email: "grok.user@x.ai" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
    const grok = {
      type: "oauth",
      access: jwtWith({ sub: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" }),
      refresh: "refresh-grok",
    };
    const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-oauth-vault-"));
    dirs.push(hanakoHome);
    let slot: Record<string, any> | null = { ...grok };
    const engine = {
      hanakoHome,
      authStorage: {
        get: vi.fn((key: string) => (key === "xai-oauth" ? slot : null)),
        reload: vi.fn(),
        logout: vi.fn(async () => { slot = null; }),
        credentials: {
          modify: vi.fn(async (_key: string, fn: (current: unknown) => unknown) => {
            slot = await fn(slot) as Record<string, any>;
            return slot;
          }),
        },
      },
      providerRegistry: {
        getAuthJsonKey: vi.fn((provider: string) => provider),
        clearAuthCache: vi.fn(),
      },
      onProviderChanged: vi.fn(async () => {}),
    };

    const listed = await listOauthAccounts(engine, "xai-oauth", { refresh: true });
    expect(listed).toEqual([
      expect.objectContaining({
        email: "grok.user@x.ai",
        displayName: "grok.user@x.ai",
        shortLabel: "grok.user",
      }),
    ]);
    expect(String(listed[0]?.displayName)).not.toMatch(/^[0-9a-f-]{8,}$/i);
    expect(slot?.email).toBe("grok.user@x.ai");
  });

  it("refreshes an expired Grok vault token before reading quota", async () => {
    vi.spyOn(xaiOAuthProvider, "refreshToken").mockResolvedValue({
      type: "oauth",
      access: "new-grok-access",
      refresh: "new-grok-refresh",
      expires: Date.now() + 3600_000,
    } as any);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/billing")) {
        return new Response(JSON.stringify({
          config: { creditUsagePercent: 79, currentPeriod: { end: "2026-08-23T04:00:00.000Z" } },
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
    const grok = {
      type: "oauth",
      access: jwtWith({ sub: "8fcc46b9-2ef3-4ab2-8c24-1414b32b138e" }),
      refresh: "refresh-grok-expired",
      expires: Date.now() - 60_000,
    };
    const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-oauth-vault-"));
    dirs.push(hanakoHome);
    let slot: Record<string, any> | null = { ...grok };
    const engine = {
      hanakoHome,
      authStorage: {
        get: vi.fn((key: string) => (key === "xai-oauth" ? slot : null)),
        reload: vi.fn(),
        logout: vi.fn(async () => { slot = null; }),
        credentials: {
          modify: vi.fn(async (_key: string, fn: (current: unknown) => unknown) => {
            slot = await fn(slot) as Record<string, any>;
            return slot;
          }),
        },
      },
      providerRegistry: {
        getAuthJsonKey: vi.fn((provider: string) => provider),
        clearAuthCache: vi.fn(),
      },
      onProviderChanged: vi.fn(async () => {}),
    };

    const listed = await listOauthAccounts(engine, "xai-oauth", { refresh: true });
    expect(xaiOAuthProvider.refreshToken).toHaveBeenCalled();
    expect(listed[0]?.usage).toMatchObject({ ok: true, remaining: 21 });
    expect(slot?.access).toBe("new-grok-access");
  });

  it("emits oauth-accounts-changed after a usage refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
    }), { status: 200 })));
    const engine = makeEngine(work) as any;
    engine._emitAppEvent = vi.fn();
    await listOauthAccounts(engine, "openai-codex-oauth", { refresh: true });
    expect(engine._emitAppEvent).toHaveBeenCalledWith(
      "oauth-accounts-changed",
      expect.objectContaining({
        provider: "openai-codex",
        accounts: expect.arrayContaining([
          expect.objectContaining({ email: "work@example.com" }),
        ]),
      }),
    );
  });

  it("shares one usage refresh when two callers race", async () => {
    let inflight = 0;
    let started = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      started += 1;
      inflight += 1;
      expect(inflight).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inflight -= 1;
      return new Response(JSON.stringify({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
      }), { status: 200 });
    }));
    const engine = makeEngine(work);
    await listOauthAccounts(engine, "openai-codex-oauth");
    await Promise.all([
      refreshOauthAccountUsages(engine, "openai-codex"),
      refreshOauthAccountUsages(engine, "openai-codex"),
    ]);
    expect(started).toBe(1);
  });
});
