/**
 * Account-bound, server-confirmed Codex speed entitlement.
 * Do not infer $500 from generic `pro`, quota size, purchased credits or stale JWT claims.
 * Official Codex uses GET /wham/accounts/check and the `promax` SKU (Pro Max).
 * No credentials/account identifiers are exposed through the public preference state.
 */
import { createHash } from "node:crypto";
import {
  availableCodexServiceTiers,
  isCodexProMaxPlan,
  normalizeCodexServiceTier,
  resolveCodexServiceTier,
} from "../../shared/codex-service-tier.ts";
import { resolveCodexUsageAccountId } from "./openai-codex-oauth-usage.ts";

const ACCOUNT_CHECK_URL = "https://chatgpt.com/backend-api/wham/accounts/check";
export const CODEX_PLAN_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 10_000;
type PlanEntry = { binding: string; planType: string | null; until: number };
type State = { generation: number; entry?: PlanEntry; flight?: { binding: string; promise: Promise<void> } };
const states = new WeakMap<object, State>();

function credentialIdentity(engine: any) {
  try {
    const cred = engine?.authStorage?.get?.("openai-codex");
    if (cred?.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) return null;
    const accountId = resolveCodexUsageAccountId({ accessToken: cred.access, accountId: cred.accountId || cred.account_id });
    if (!accountId) return null;
    return {
      access: cred.access,
      accountId,
      binding: createHash("sha256").update(JSON.stringify([accountId, cred.access])).digest("hex"),
    };
  } catch { return null; }
}

/** Supports both official accounts/check wire shapes; never borrows another account's plan. */
export function codexPlanFromAccountsResponse(data: any, accountId: string): string | null {
  if (!accountId || !data || typeof data !== "object") return null;
  const accounts = data.accounts;
  const rows = Array.isArray(accounts)
    ? accounts.filter(row => (row?.account?.account_id || row?.account?.id || row?.account_id || row?.id) === accountId)
    : accounts && typeof accounts === "object" && Object.hasOwn(accounts, accountId)
      ? [accounts[accountId]] : [];
  const plans: string[] = [];
  for (const row of rows) {
    const account = row?.account || row;
    const returnedId = account?.account_id || account?.id;
    if (returnedId && returnedId !== accountId) return null;
    const plan = typeof account?.plan_type === "string" ? account.plan_type.trim().toLowerCase() : "";
    if (!plan) return null;
    plans.push(plan);
  }
  return plans.length > 0 && new Set(plans).size === 1 ? plans[0] : null;
}

export function getCodexServiceTierState(engine: any, modelId?: unknown, now = Date.now()) {
  const preferredTier = normalizeCodexServiceTier(engine?.preferences?.getCodexServiceTier?.());
  const identity = credentialIdentity(engine);
  const entry = engine && states.get(engine)?.entry;
  const planType = identity && entry?.binding === identity.binding && entry.until > now ? entry.planType : null;
  const ultrafastEligible = isCodexProMaxPlan(planType);
  return {
    tier: resolveCodexServiceTier(preferredTier, ultrafastEligible, modelId),
    preferredTier,
    options: availableCodexServiceTiers(ultrafastEligible, modelId),
    ultrafastEligible,
    planType,
  };
}

/** Refreshes only the live account, coalesces concurrent reads, and rejects late results after switches. */
export async function refreshCodexServiceEntitlement(engine: any, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  now = () => Date.now(),
}: { fetchImpl?: typeof globalThis.fetch; timeoutMs?: number; now?: () => number } = {}): Promise<void> {
  if (!engine || typeof engine !== "object") return;
  let state = states.get(engine);
  if (!state) { state = { generation: 0 }; states.set(engine, state); }
  const identity = credentialIdentity(engine);
  if (!identity) {
    state.generation++;
    delete state.entry;
    delete state.flight;
    return;
  }
  if (state.entry?.binding === identity.binding && state.entry.until > now()) return;
  if (state.flight?.binding === identity.binding) { await state.flight.promise; return; }
  const generation = ++state.generation;
  delete state.entry;
  const work = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let planType: string | null = null;
    try {
      const response = await fetchImpl(ACCOUNT_CHECK_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${identity.access}`,
          "ChatGPT-Account-ID": identity.accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: "pi",
        },
        signal: controller.signal,
      });
      if (response.ok) planType = codexPlanFromAccountsResponse(await response.json(), identity.accountId);
    } catch {
      // Network, revoked login and unknown responses all close the entitlement gate.
    } finally { clearTimeout(timer); }
    if (state!.generation === generation && credentialIdentity(engine)?.binding === identity.binding) {
      state!.entry = { binding: identity.binding, planType, until: now() + (planType ? CODEX_PLAN_CACHE_MS : FAILURE_CACHE_MS) };
    }
  })();
  state.flight = { binding: identity.binding, promise: work };
  try { await work; }
  finally { if (state.flight?.promise === work) delete state.flight; }
}
