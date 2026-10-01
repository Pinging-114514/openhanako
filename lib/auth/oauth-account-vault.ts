/**
 * Local multi-account vault for Codex / Grok OAuth.
 *
 * Pi still has one slot per provider in auth.json. This file keeps the other
 * saved accounts, and switching copies the chosen credential into that slot.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeSecretFileSync } from "../../shared/secret-fs.ts";
import {
  mergeOauthUsageSnapshot,
  publicOauthUsage,
  type OauthUsageSnapshot,
} from "../../shared/oauth-usage.ts";
import { fetchCodexOauthUsage, publicCodexOauthUsage } from "./openai-codex-oauth-usage.ts";
import { fetchXaiOauthUsage, fetchXaiOauthUserinfo, publicXaiOauthUsage } from "./xai-oauth-usage.ts";
import { xaiOAuthProvider } from "./xai-oauth.ts";
import {
  CODEX_AUTH_KEY,
  MULTI_OAUTH_AUTH_KEYS,
  XAI_AUTH_KEY,
  inspectOauthCredential,
  isOauthCredential,
  normalizeMultiOauthAuthKey,
  resolveOauthAccountLabels,
  type MultiOauthAuthKey,
} from "./oauth-account-identity.ts";

export const OAUTH_ACCOUNT_VAULT_FILENAME = "oauth-accounts.json";

export interface OauthAccountUsagePublic extends OauthUsageSnapshot {}

export interface OauthAccountUsageRecord extends OauthAccountUsagePublic {
  fetchedAt: string | null;
}

export interface OauthAccountProfile {
  id: string;
  matchKey: string;
  accountId: string;
  email: string;
  displayName: string;
  shortLabel: string;
  credential: Record<string, any>;
  usage: OauthAccountUsageRecord | null;
  updatedAt: string;
}

export interface OauthAccountProviderState {
  activeId: string | null;
  profiles: OauthAccountProfile[];
}

export interface OauthAccountVault {
  version: 1;
  providers: Partial<Record<MultiOauthAuthKey, OauthAccountProviderState>>;
}

export interface PublicOauthAccount {
  id: string;
  accountId: string;
  email: string;
  displayName: string;
  shortLabel: string;
  active: boolean;
  usage: OauthAccountUsagePublic | null;
}

export function oauthAccountVaultPath(hanakoHome: string): string {
  return path.join(hanakoHome, OAUTH_ACCOUNT_VAULT_FILENAME);
}

export function emptyOauthAccountVault(): OauthAccountVault {
  return { version: 1, providers: {} };
}

export function readOauthAccountVault(hanakoHome: string): OauthAccountVault {
  if (!hanakoHome) return emptyOauthAccountVault();
  try {
    const raw = JSON.parse(fs.readFileSync(oauthAccountVaultPath(hanakoHome), "utf-8"));
    return normalizeVault(raw);
  } catch {
    return emptyOauthAccountVault();
  }
}

export function writeOauthAccountVault(hanakoHome: string, vault: OauthAccountVault): void {
  if (!hanakoHome) return;
  writeSecretFileSync(oauthAccountVaultPath(hanakoHome), `${JSON.stringify(normalizeVault(vault), null, 2)}\n`);
}

export function upsertOauthCredential(
  vault: OauthAccountVault,
  authKey: MultiOauthAuthKey,
  cred: unknown,
  usage?: OauthAccountUsageRecord | null,
): { vault: OauthAccountVault; profile: OauthAccountProfile } {
  const identity = inspectOauthCredential(cred, authKey);
  if (!identity || !isOauthCredential(cred)) {
    throw new Error(`Cannot save OAuth account for "${authKey}": credential is not usable`);
  }
  const now = new Date().toISOString();
  const next = cloneVault(vault);
  const provider = ensureProvider(next, authKey);
  const existing = provider.profiles.find(profile => profile.matchKey === identity.matchKey);
  const labels = resolveOauthAccountLabels({
    email: identity.email || existing?.email || "",
    displayName: identity.displayName,
  }, authKey);
  const credential = cloneCredential(cred);
  if (labels.email) credential.email = labels.email;
  const profile: OauthAccountProfile = {
    id: existing?.id || newProfileId(),
    matchKey: identity.matchKey,
    accountId: identity.accountId || existing?.accountId || "",
    email: labels.email,
    displayName: labels.displayName,
    shortLabel: labels.shortLabel,
    credential,
    usage: usage === undefined ? (existing?.usage ?? null) : usage,
    updatedAt: now,
  };
  provider.profiles = [
    profile,
    ...provider.profiles.filter(item => item.id !== profile.id),
  ];
  provider.activeId = profile.id;
  return { vault: next, profile };
}

export function setActiveOauthAccount(
  vault: OauthAccountVault,
  authKey: MultiOauthAuthKey,
  profileId: string,
): OauthAccountVault {
  const next = cloneVault(vault);
  const provider = ensureProvider(next, authKey);
  if (!provider.profiles.some(profile => profile.id === profileId)) {
    throw new Error(`OAuth account "${profileId}" was not found`);
  }
  provider.activeId = profileId;
  return next;
}

export function removeOauthAccount(
  vault: OauthAccountVault,
  authKey: MultiOauthAuthKey,
  profileId: string,
): { vault: OauthAccountVault; nextActive: OauthAccountProfile | null } {
  const next = cloneVault(vault);
  const provider = ensureProvider(next, authKey);
  const remaining = provider.profiles.filter(profile => profile.id !== profileId);
  if (remaining.length === provider.profiles.length) {
    throw new Error(`OAuth account "${profileId}" was not found`);
  }
  provider.profiles = remaining;
  if (provider.activeId === profileId) {
    provider.activeId = remaining[0]?.id || null;
  }
  if (remaining.length === 0) {
    delete next.providers[authKey];
    return { vault: next, nextActive: null };
  }
  const nextActive = remaining.find(profile => profile.id === provider.activeId) || remaining[0];
  provider.activeId = nextActive.id;
  return { vault: next, nextActive };
}

export function listCachedOauthAccounts(engine: any, provider: unknown): PublicOauthAccount[] {
  const authKey = resolveEngineOauthAuthKey(engine, provider);
  if (!authKey || !engine?.hanakoHome) return [];
  try {
    return publicOauthAccounts(readOauthAccountVault(engine.hanakoHome), authKey);
  } catch {
    return [];
  }
}

export function publicOauthAccounts(
  vault: OauthAccountVault,
  authKey: MultiOauthAuthKey,
): PublicOauthAccount[] {
  const provider = vault.providers[authKey];
  if (!provider) return [];
  return provider.profiles.map(profile => {
    const labels = resolveOauthAccountLabels(profile, authKey);
    return {
      id: profile.id,
      accountId: profile.accountId,
      email: labels.email,
      displayName: labels.displayName,
      shortLabel: labels.shortLabel,
      active: profile.id === provider.activeId,
      usage: publicUsage(profile.usage),
    };
  });
}

export function resolveEngineOauthAuthKey(engine: any, provider: unknown): MultiOauthAuthKey | null {
  const fromRegistry = engine?.providerRegistry?.getAuthJsonKey?.(provider)
    || engine?.providerRegistry?.resolveChatProvider?.(provider)?.sourceProviderId
    || provider;
  return normalizeMultiOauthAuthKey(fromRegistry) || normalizeMultiOauthAuthKey(provider);
}

export function syncOauthSlotIntoVault(engine: any, authKey: MultiOauthAuthKey): OauthAccountProfile | null {
  const cred = engine?.authStorage?.get?.(authKey);
  if (!isOauthCredential(cred)) return null;
  const vault = readOauthAccountVault(engine.hanakoHome);
  const { vault: next, profile } = upsertOauthCredential(vault, authKey, cred);
  writeOauthAccountVault(engine.hanakoHome, next);
  return profile;
}

export async function afterOauthLogin(engine: any, provider: unknown): Promise<void> {
  const authKey = resolveEngineOauthAuthKey(engine, provider);
  if (!authKey) return;
  syncOauthSlotIntoVault(engine, authKey);
  await refreshOauthAccountUsages(engine, authKey);
}

export async function activateOauthAccount(
  engine: any,
  provider: unknown,
  profileId: string,
): Promise<PublicOauthAccount[]> {
  const authKey = requireAuthKey(engine, provider);
  syncOauthSlotIntoVault(engine, authKey);
  const prepared = readOauthAccountVault(engine.hanakoHome);
  const profile = prepared.providers[authKey]?.profiles.find(item => item.id === profileId);
  if (!profile) throw new Error(`OAuth account "${profileId}" was not found`);
  const credential = cloneCredential(profile.credential);
  await writeCredentialToSlot(engine, authKey, credential);
  const fresh = readOauthAccountVault(engine.hanakoHome);
  if (!fresh.providers[authKey]?.profiles.some(item => item.id === profileId)) {
    throw new Error(`OAuth account "${profileId}" was not found`);
  }
  writeOauthAccountVault(engine.hanakoHome, setActiveOauthAccount(fresh, authKey, profileId));
  await afterSlotChanged(engine, authKey);
  return listOauthAccounts(engine, authKey);
}

export async function removeStoredOauthAccount(
  engine: any,
  provider: unknown,
  profileId: string,
): Promise<PublicOauthAccount[]> {
  const authKey = requireAuthKey(engine, provider);
  syncOauthSlotIntoVault(engine, authKey);
  const { vault, nextActive } = removeOauthAccount(
    readOauthAccountVault(engine.hanakoHome),
    authKey,
    profileId,
  );
  writeOauthAccountVault(engine.hanakoHome, vault);
  if (nextActive) {
    await writeCredentialToSlot(engine, authKey, nextActive.credential);
  } else {
    await engine.authStorage.logout(authKey);
  }
  await afterSlotChanged(engine, authKey);
  return listOauthAccounts(engine, authKey);
}

export async function logoutActiveOauthAccount(engine: any, provider: unknown): Promise<PublicOauthAccount[]> {
  const authKey = requireAuthKey(engine, provider);
  syncOauthSlotIntoVault(engine, authKey);
  const vault = readOauthAccountVault(engine.hanakoHome);
  const activeId = vault.providers[authKey]?.activeId;
  if (activeId) return removeStoredOauthAccount(engine, authKey, activeId);
  await engine.authStorage.logout(authKey);
  await afterSlotChanged(engine, authKey);
  return [];
}

export async function listOauthAccounts(
  engine: any,
  provider: unknown,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<PublicOauthAccount[]> {
  const authKey = requireAuthKey(engine, provider);
  syncOauthSlotIntoVault(engine, authKey);
  if (refresh) await refreshOauthAccountUsages(engine, authKey);
  return publicOauthAccounts(readOauthAccountVault(engine.hanakoHome), authKey);
}

const VAULT_CREDENTIAL_REFRESH_SKEW_MS = 2 * 60 * 1000;

function credentialNeedsRefresh(cred: Record<string, any> | null | undefined): boolean {
  const expires = Number(cred?.expires);
  return Number.isFinite(expires) && expires <= Date.now() + VAULT_CREDENTIAL_REFRESH_SKEW_MS;
}

function credentialEpoch(cred: Record<string, any> | null | undefined): string {
  const access = typeof cred?.access === "string" ? cred.access : "";
  const refresh = typeof cred?.refresh === "string" ? cred.refresh : "";
  return `${access}\n${refresh}`;
}

function sameOauthAccount(authKey: MultiOauthAuthKey, left: unknown, right: unknown): boolean {
  const a = inspectOauthCredential(left, authKey);
  const b = inspectOauthCredential(right, authKey);
  if (!a || !b) return false;
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  if (a.email && b.email) return a.email === b.email;
  return a.matchKey === b.matchKey && a.matchKey.length > 0;
}

function liveCredentialSupersedes(stored: Record<string, any>, live: Record<string, any>): boolean {
  if (credentialNeedsRefresh(live)) return false;
  return credentialNeedsRefresh(stored) || stored.access !== live.access;
}

function adoptLiveCredential(
  authKey: MultiOauthAuthKey,
  stored: Record<string, any>,
  live: unknown,
): Record<string, any> | null {
  if (!isOauthCredential(live) || !sameOauthAccount(authKey, stored, live)) return null;
  if (!liveCredentialSupersedes(stored, live)) return null;
  const cred = cloneCredential(live);
  if (!cred.email && stored.email) cred.email = stored.email;
  return cred;
}

function toXaiRefreshCredentials(cred: Record<string, any>): {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
} | null {
  if (typeof cred.refresh !== "string" || !cred.refresh) return null;
  if (typeof cred.access !== "string" || !cred.access) return null;
  const expires = Number(cred.expires);
  if (!Number.isFinite(expires)) return null;
  const credentials: {
    refresh: string;
    access: string;
    expires: number;
    [key: string]: unknown;
  } = {
    refresh: cred.refresh,
    access: cred.access,
    expires,
  };
  for (const [key, value] of Object.entries(cred)) {
    if (key === "refresh" || key === "access" || key === "expires") continue;
    credentials[key] = value;
  }
  return credentials;
}

async function refreshVaultCredential(
  authKey: MultiOauthAuthKey,
  cred: Record<string, any>,
): Promise<Record<string, any> | null> {
  if (authKey !== XAI_AUTH_KEY) return null;
  const credentials = toXaiRefreshCredentials(cred);
  if (!credentials) return null;
  try {
    const next = await xaiOAuthProvider.refreshToken(credentials, new AbortController().signal);
    if (!next || typeof next.access !== "string" || !next.access) return null;
    return { ...cloneCredential(cred), ...next, type: "oauth" };
  } catch {
    return null;
  }
}

const usageRefreshInflight = new WeakMap<object, Map<string, Promise<void>>>();

function usageRefreshWork(engine: any): Map<string, Promise<void>> {
  let map = usageRefreshInflight.get(engine);
  if (!map) {
    map = new Map();
    usageRefreshInflight.set(engine, map);
  }
  return map;
}

export function emitOauthAccountsChanged(engine: any, authKey: MultiOauthAuthKey): void {
  if (!engine || typeof engine._emitAppEvent !== "function") return;
  try {
    engine._emitAppEvent("oauth-accounts-changed", {
      provider: authKey,
      accounts: publicOauthAccounts(readOauthAccountVault(engine.hanakoHome), authKey),
    });
  } catch {
    // UI sync must not fail a successful vault write.
  }
}

export async function refreshOauthAccountUsages(engine: any, authKey: MultiOauthAuthKey): Promise<void> {
  const vault = readOauthAccountVault(engine.hanakoHome);
  const provider = vault.providers[authKey];
  if (!provider || provider.profiles.length === 0) return;
  const pending = usageRefreshWork(engine).get(authKey);
  if (pending) {
    await pending;
    return;
  }
  const work = refreshOauthAccountUsagesOnce(engine, authKey);
  usageRefreshWork(engine).set(authKey, work);
  try {
    await work;
  } finally {
    const map = usageRefreshWork(engine);
    if (map.get(authKey) === work) map.delete(authKey);
  }
}

type PreparedOauthUsage = {
  id: string;
  baseCredential: Record<string, any>;
  nextCredential: Record<string, any>;
  fetchedAccess: string | null;
  usage: OauthAccountUsagePublic | null | undefined;
  email: string;
  displayName: string;
  shortLabel: string;
  accountId: string;
};

async function refreshOauthAccountUsagesOnce(engine: any, authKey: MultiOauthAuthKey): Promise<void> {
  const vault = readOauthAccountVault(engine.hanakoHome);
  const provider = vault.providers[authKey];
  if (!provider || provider.profiles.length === 0) return;
  const fetchedAt = new Date().toISOString();
  const prepared: PreparedOauthUsage[] = [];
  for (const profile of provider.profiles) {
    const baseCredential = cloneCredential(profile.credential);
    let cred = cloneCredential(profile.credential);
    const adopted = adoptLiveCredential(authKey, cred, engine?.authStorage?.get?.(authKey));
    if (adopted) cred = adopted;
    if (credentialNeedsRefresh(cred)) {
      const refreshed = await refreshVaultCredential(authKey, cred);
      if (refreshed) cred = refreshed;
    }
    const liveAfterRefresh = adoptLiveCredential(authKey, cred, engine?.authStorage?.get?.(authKey));
    if (liveAfterRefresh) cred = liveAfterRefresh;
    const labeled = authKey === XAI_AUTH_KEY
      ? await withXaiEmail({ ...profile, credential: cred })
      : {
        ...profile,
        credential: cred,
        ...resolveOauthAccountLabels({
          email: cred.email || profile.email,
          displayName: profile.displayName,
        }, authKey),
      };
    cred = labeled.credential;
    let usage: OauthAccountUsagePublic | null | undefined;
    if (credentialNeedsRefresh(cred)) {
      // Expired access that we could not refresh is not proof the account was revoked.
      usage = undefined;
    } else {
      usage = await fetchUsageForCredential(authKey, cred);
    }
    prepared.push({
      id: profile.id,
      baseCredential,
      nextCredential: cloneCredential(cred),
      fetchedAccess: usage === undefined ? null : String(cred.access || ""),
      usage,
      email: labeled.email,
      displayName: labeled.displayName,
      shortLabel: labeled.shortLabel,
      accountId: labeled.accountId || profile.accountId,
    });
  }
  commitPreparedOauthUsage(engine, authKey, prepared, fetchedAt);
  for (const update of prepared) {
    try {
      await compareAndSwapSlotCredential(engine, authKey, update.baseCredential, update.nextCredential);
    } catch {
      // Vault already has a committed credential; the live slot can catch up on the next switch.
    }
  }
  const committed = readOauthAccountVault(engine.hanakoHome).providers[authKey];
  const active = committed?.profiles.find(profile => profile.id === committed.activeId);
  if (authKey === CODEX_AUTH_KEY) {
    engine.codexOauthUsage = active?.usage || null;
  }
  if (authKey === XAI_AUTH_KEY) {
    engine.xaiOauthUsage = active?.usage || null;
  }
  emitOauthAccountsChanged(engine, authKey);
}

function commitPreparedOauthUsage(
  engine: any,
  authKey: MultiOauthAuthKey,
  prepared: PreparedOauthUsage[],
  fetchedAt: string,
): void {
  const vault = readOauthAccountVault(engine.hanakoHome);
  const provider = vault.providers[authKey];
  if (!provider) return;
  let changed = false;
  for (const update of prepared) {
    const profile = provider.profiles.find(item => item.id === update.id);
    if (!profile) continue;
    const holdsBase = credentialEpoch(profile.credential) === credentialEpoch(update.baseCredential);
    if (holdsBase) {
      const nextEpoch = credentialEpoch(update.nextCredential);
      const epochChanged = credentialEpoch(profile.credential) !== nextEpoch;
      const emailChanged = (profile.credential.email || "") !== (update.nextCredential.email || "")
        || profile.email !== update.email;
      if (epochChanged || emailChanged) {
        profile.credential = cloneCredential(update.nextCredential);
        profile.email = update.email;
        profile.displayName = update.displayName;
        profile.shortLabel = update.shortLabel;
        if (update.accountId) profile.accountId = update.accountId;
        profile.updatedAt = fetchedAt;
        changed = true;
      }
    }
    const storedAccess = String(profile.credential?.access || "");
    if (update.usage !== undefined && update.fetchedAccess && storedAccess === update.fetchedAccess) {
      const merged = mergeOauthUsageSnapshot(profile.usage, update.usage);
      const nextUsage = merged ? { ...merged, fetchedAt } : profile.usage;
      if (JSON.stringify(nextUsage) !== JSON.stringify(profile.usage)) {
        profile.usage = nextUsage;
        changed = true;
      }
    }
  }
  if (changed) writeOauthAccountVault(engine.hanakoHome, vault);
}

async function compareAndSwapSlotCredential(
  engine: any,
  authKey: MultiOauthAuthKey,
  base: Record<string, any>,
  next: Record<string, any>,
): Promise<void> {
  const modify = engine?.authStorage?.credentials?.modify;
  if (typeof modify !== "function") return;
  const baseEpoch = credentialEpoch(base);
  const nextEpoch = credentialEpoch(next);
  const nextEmail = typeof next.email === "string" ? next.email : "";
  const nextName = typeof next.name === "string" ? next.name : "";
  if (baseEpoch === nextEpoch && nextEmail === (base.email || "") && nextName === (base.name || "")) return;
  await modify.call(engine.authStorage.credentials, authKey, async (current: unknown) => {
    if (!isOauthCredential(current)) return current;
    const currentEpoch = credentialEpoch(current);
    const holdsBase = currentEpoch === baseEpoch;
    const holdsNext = currentEpoch === nextEpoch;
    if (!holdsBase && !holdsNext) return current;
    if (holdsNext && (current.email || "") === nextEmail && (current.name || "") === nextName) return current;
    return cloneCredential(next);
  });
  engine.authStorage.reload?.();
}

export function importOauthSlotsIntoVault(engine: any): void {
  for (const authKey of MULTI_OAUTH_AUTH_KEYS) {
    try {
      syncOauthSlotIntoVault(engine, authKey);
    } catch {
      // A unreadable slot must not block the other provider.
    }
  }
}

async function writeCredentialToSlot(engine: any, authKey: MultiOauthAuthKey, cred: Record<string, any>): Promise<void> {
  const modify = engine?.authStorage?.credentials?.modify;
  if (typeof modify !== "function") {
    throw new Error(`Cannot switch OAuth account for "${authKey}": credential store is unavailable`);
  }
  await modify.call(engine.authStorage.credentials, authKey, async () => cloneCredential(cred));
  engine.authStorage.reload?.();
}

async function afterSlotChanged(engine: any, authKey: MultiOauthAuthKey): Promise<void> {
  engine.providerRegistry?.clearAuthCache?.();
  try {
    await engine.onProviderChanged?.();
  } catch {
    // Model sync failure should not roll back a successful slot write.
  }
  await refreshOauthAccountUsages(engine, authKey);
  emitOauthAccountsChanged(engine, authKey);
}

async function withXaiEmail(profile: OauthAccountProfile): Promise<OauthAccountProfile> {
  const labeled = { ...profile, ...resolveOauthAccountLabels(profile, XAI_AUTH_KEY) };
  if (labeled.email.includes("@")) return labeled;
  const info = await fetchXaiOauthUserinfo({ accessToken: profile.credential?.access });
  if (!info.email) return labeled;
  const credential = cloneCredential(profile.credential);
  credential.email = info.email;
  if (info.name) credential.name = info.name;
  return {
    ...labeled,
    ...resolveOauthAccountLabels({ email: info.email, displayName: labeled.displayName }, XAI_AUTH_KEY),
    credential,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchUsageForCredential(
  authKey: MultiOauthAuthKey,
  cred: Record<string, any>,
): Promise<OauthAccountUsagePublic | null> {
  if (authKey === CODEX_AUTH_KEY) {
    return asPublicUsage(publicCodexOauthUsage(await fetchCodexOauthUsage({
      accessToken: cred.access,
      accountId: cred.accountId || cred.account_id || "",
    })));
  }
  return asPublicUsage(publicXaiOauthUsage(await fetchXaiOauthUsage({
    accessToken: cred.access,
  })));
}

function asPublicUsage(usage: Record<string, any> | null | undefined): OauthAccountUsagePublic | null {
  return publicOauthUsage(usage);
}

function publicUsage(usage: OauthAccountUsageRecord | null | undefined): OauthAccountUsagePublic | null {
  return publicOauthUsage(usage);
}

function requireAuthKey(engine: any, provider: unknown): MultiOauthAuthKey {
  const authKey = resolveEngineOauthAuthKey(engine, provider);
  if (!authKey) throw new Error("Only Codex and Grok OAuth accounts can be saved");
  return authKey;
}

function ensureProvider(vault: OauthAccountVault, authKey: MultiOauthAuthKey): OauthAccountProviderState {
  if (!vault.providers[authKey]) {
    vault.providers[authKey] = { activeId: null, profiles: [] };
  }
  return vault.providers[authKey] as OauthAccountProviderState;
}

function normalizeVault(raw: unknown): OauthAccountVault {
  const root = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, any>
    : {};
  const vault = emptyOauthAccountVault();
  const providers = root.providers && typeof root.providers === "object" ? root.providers : {};
  for (const authKey of MULTI_OAUTH_AUTH_KEYS) {
    const item = providers[authKey];
    if (!item || typeof item !== "object") continue;
    const profiles = Array.isArray(item.profiles)
      ? item.profiles.map(profile => normalizeProfile(profile, authKey)).filter((profile): profile is OauthAccountProfile => !!profile)
      : [];
    if (profiles.length === 0) continue;
    const activeId = typeof item.activeId === "string" && profiles.some(profile => profile.id === item.activeId)
      ? item.activeId
      : profiles[0].id;
    vault.providers[authKey] = { activeId, profiles };
  }
  return vault;
}

function normalizeProfile(raw: unknown, authKey: MultiOauthAuthKey): OauthAccountProfile | null {
  const item = raw && typeof raw === "object" ? raw as Record<string, any> : null;
  if (!item || typeof item.id !== "string" || !isOauthCredential(item.credential)) return null;
  const identity = inspectOauthCredential(item.credential, authKey);
  if (!identity) return null;
  const labels = resolveOauthAccountLabels({
    email: typeof item.email === "string" ? item.email : identity.email,
    displayName: typeof item.displayName === "string" ? item.displayName : identity.displayName,
  }, authKey);
  return {
    id: item.id,
    matchKey: typeof item.matchKey === "string" && item.matchKey ? item.matchKey : identity.matchKey,
    accountId: typeof item.accountId === "string" ? item.accountId : identity.accountId,
    email: labels.email || identity.email,
    displayName: labels.displayName,
    shortLabel: labels.shortLabel,
    credential: cloneCredential(item.credential),
    usage: normalizeUsage(item.usage),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

function normalizeUsage(raw: unknown): OauthAccountUsageRecord | null {
  const usage = publicOauthUsage(raw);
  if (!usage) return null;
  const item = raw && typeof raw === "object" ? raw as Record<string, any> : {};
  return {
    ...usage,
    fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
  };
}

function cloneVault(vault: OauthAccountVault): OauthAccountVault {
  return structuredClone(normalizeVault(vault));
}

function cloneCredential(cred: Record<string, any>): Record<string, any> {
  return structuredClone(cred);
}

function newProfileId(): string {
  return crypto.randomUUID();
}
