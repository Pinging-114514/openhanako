import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createPreferencesRoute } from "../server/routes/preferences.ts";
import {
  CODEX_PLAN_CACHE_MS,
  codexPlanFromAccountsResponse,
  getCodexServiceTierState,
  refreshCodexServiceEntitlement,
} from "../lib/auth/codex-service-entitlement.ts";
import { availableCodexServiceTiers, isCodexProMaxPlan, resolveCodexServiceTier } from "../shared/codex-service-tier.ts";

function harness(plan: string | null = "promax") {
  let credential: any = { type: "oauth", access: "fake-access-a", accountId: "account-a" };
  let tier = "ultrafast";
  let time = 100_000;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accounts: [{ id: credential?.accountId, plan_type: plan }] })));
  const engine: any = {
    authStorage: { get: () => credential },
    preferences: { getCodexServiceTier: () => tier },
    getCodexServiceTierState: (modelId?: unknown) => getCodexServiceTierState(engine, modelId, time),
    getCodexServiceTier: () => getCodexServiceTierState(engine, undefined, time).tier,
    setCodexServiceTier: vi.fn((next: string) => { tier = next; return next; }),
    refreshCodexServiceEntitlement: () => refreshCodexServiceEntitlement(engine, { fetchImpl, now: () => time }),
  };
  return { engine, fetchImpl, setCredential: (next: any) => { credential = next; }, advance: (ms: number) => { time += ms; } };
}

describe("Codex Pro Max policy", () => {
  it.each(["pro", "prolite", "plus", "enterprise", "edu_pro", "pro_500", "$500", "", null, 500])("does not infer Pro $500 from %s", value => {
    expect(isCodexProMaxPlan(value)).toBe(false);
    expect(availableCodexServiceTiers(false)).toEqual(["standard", "fast"]);
  });
  it("recognizes the official SKU without changing the standard/fast defaults", () => {
    expect(isCodexProMaxPlan(" ProMax ")).toBe(true);
    expect(availableCodexServiceTiers(true)).toEqual(["standard", "fast", "ultrafast"]);
    expect(resolveCodexServiceTier("ultrafast", false)).toBe("fast");
    expect(resolveCodexServiceTier("standard", false)).toBe("standard");
    expect(resolveCodexServiceTier("priority", false)).toBe("fast");
  });
  it.each(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.5", "", null])("does not offer ultrafast on unsupported model %s, even to Pro Max", model => {
    expect(availableCodexServiceTiers(true, model)).toEqual(["standard", "fast"]);
    expect(resolveCodexServiceTier("ultrafast", true, model)).toBe("fast");
  });
  it.each(["gpt-6-astra", "OPENAI/GPT-6-ASTRA", "gpt-6-astra-2026-09-01"])("allows supported Astra model %s", model => {
    expect(availableCodexServiceTiers(true, model)).toContain("ultrafast");
  });
});

describe("server plan discovery", () => {
  it("accepts both official response shapes and ignores a different account", () => {
    expect(codexPlanFromAccountsResponse({ accounts: [{ id: "b", plan_type: "promax" }, { id: "a", plan_type: "pro" }] }, "a")).toBe("pro");
    expect(codexPlanFromAccountsResponse({ accounts: { a: { account: { account_id: "a", plan_type: "promax" } } } }, "a")).toBe("promax");
    expect(codexPlanFromAccountsResponse({ accounts: { a: { account: { account_id: "b", plan_type: "promax" } } } }, "a")).toBeNull();
    expect(codexPlanFromAccountsResponse({ accounts: [{ id: "b", plan_type: "promax" }] }, "a")).toBeNull();
    expect(codexPlanFromAccountsResponse({ accounts: [{ id: "a", plan_type: "promax" }, { id: "a", plan_type: "pro" }] }, "a")).toBeNull();
  });
  it("starts closed, opens only after a successful account-bound check, and caches reads", async () => {
    const { engine, fetchImpl } = harness();
    expect(engine.getCodexServiceTierState()).toMatchObject({ tier: "fast", preferredTier: "ultrafast", ultrafastEligible: false });
    await engine.refreshCodexServiceEntitlement();
    expect(engine.getCodexServiceTierState()).toMatchObject({ tier: "ultrafast", ultrafastEligible: true });
    expect(engine.getCodexServiceTierState("gpt-6.1-sol").tier).toBe("fast");
    await engine.refreshCodexServiceEntitlement();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(engine.getCodexServiceTierState())).not.toContain("fake-access");
    expect(JSON.stringify(engine.getCodexServiceTierState())).not.toContain("account-a");
  });
  it("does not let an old account, refreshed token or logout reuse a positive entitlement", async () => {
    const { engine, setCredential } = harness();
    await engine.refreshCodexServiceEntitlement();
    for (const credential of [
      { type: "oauth", access: "fake-access-b", accountId: "account-b" },
      { type: "oauth", access: "rotated-a", accountId: "account-a" },
      null,
    ]) {
      setCredential(credential);
      expect(engine.getCodexServiceTierState().ultrafastEligible).toBe(false);
      expect(engine.getCodexServiceTierState().tier).toBe("fast");
    }
  });
  it("expires positive results and fails closed on a subsequent upstream error", async () => {
    const { engine, fetchImpl, advance } = harness();
    await engine.refreshCodexServiceEntitlement();
    advance(CODEX_PLAN_CACHE_MS + 1);
    expect(engine.getCodexServiceTierState().ultrafastEligible).toBe(false);
    fetchImpl.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await engine.refreshCodexServiceEntitlement();
    expect(engine.getCodexServiceTierState().ultrafastEligible).toBe(false);
  });
  it.each([null, "pro", "prolite", "enterprise"])("does not authorize a missing or non-500 server plan %s", async plan => {
    const { engine } = harness(plan);
    await engine.refreshCodexServiceEntitlement();
    expect(engine.getCodexServiceTierState().ultrafastEligible).toBe(false);
  });
  it("coalesces same-account lookups and discards late responses after switching", async () => {
    const { engine, fetchImpl, setCredential } = harness();
    let finish!: (response: Response) => void;
    fetchImpl.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = engine.refreshCodexServiceEntitlement();
    const same = engine.refreshCodexServiceEntitlement();
    expect(fetchImpl).toHaveBeenCalledOnce();
    setCredential({ type: "oauth", access: "fake-b", accountId: "account-b" });
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ accounts: [{ id: "account-b", plan_type: "pro" }] })));
    await engine.refreshCodexServiceEntitlement();
    finish(new Response(JSON.stringify({ accounts: [{ id: "account-a", plan_type: "promax" }] })));
    await Promise.all([first, same]);
    expect(engine.getCodexServiceTierState()).toMatchObject({ tier: "fast", planType: "pro", ultrafastEligible: false });
  });
  it("does not use an unverified JWT plan or a 500 credit balance as entitlement", async () => {
    const { engine, setCredential } = harness(null);
    setCredential({ type: "oauth", accountId: "account-a", access: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "promax" }, credits: 500 })).toString("base64url")}.signature` });
    await engine.refreshCodexServiceEntitlement();
    expect(engine.getCodexServiceTierState().ultrafastEligible).toBe(false);
  });
  it("stops waiting on an aborted network request", async () => {
    const { engine } = harness();
    const fetchImpl: any = (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    await refreshCodexServiceEntitlement(engine, { fetchImpl, timeoutMs: 5 });
    expect(getCodexServiceTierState(engine).ultrafastEligible).toBe(false);
  });
});

describe("Codex preference route enforcement", () => {
  function appFor(engine: any) { const app = new Hono(); app.route("/api", createPreferencesRoute(engine)); return app; }
  const put = (tier: string, modelId?: string) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, ...(modelId ? { modelId } : {}) }) });
  it("hides and rejects ultrafast for ordinary Pro without changing stored preference", async () => {
    const { engine } = harness("pro"); const app = appFor(engine);
    const get = await app.request("/api/preferences/codex-service-tier");
    expect(await get.json()).toMatchObject({ tier: "fast", options: ["standard", "fast"], ultrafastEligible: false });
    const response = await app.request("/api/preferences/codex-service-tier", put("ultrafast"));
    expect(response.status).toBe(403);
    expect(engine.setCodexServiceTier).not.toHaveBeenCalled();
  });
  it("allows global/Astra ultrafast for a verified Pro Max and rejects Sol", async () => {
    const { engine } = harness(); const app = appFor(engine);
    expect((await app.request("/api/preferences/codex-service-tier", put("ultrafast", "gpt-6-astra"))).status).toBe(200);
    expect((await app.request("/api/preferences/codex-service-tier", put("ultrafast", "gpt-6.1-sol"))).status).toBe(403);
    expect((await (await app.request("/api/preferences/codex-service-tier?modelId=gpt-6.1-sol")).json()).options).toEqual(["standard", "fast"]);
  });
  it("continues accepting standard and fast while verification is unavailable", async () => {
    const { engine } = harness(null); const app = appFor(engine);
    for (const tier of ["standard", "fast", "priority"]) {
      const response = await app.request("/api/preferences/codex-service-tier", put(tier));
      expect(response.status).toBe(200);
      expect((await response.json()).tier).toBe(tier === "priority" ? "fast" : tier);
    }
  });
});
