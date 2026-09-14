import {
  mergeAccountUsage,
  normalizeOauthAccount,
  type OauthAccount,
} from '../utils/oauth-account';

export const OAUTH_ACCOUNTS_CHANGED_EVENT = 'hana-oauth-accounts';
export const OAUTH_ACCOUNTS_MIN_REFRESH_GAP_MS = 15_000;

export type OauthAccountsFetch = (path: string, opts?: RequestInit) => Promise<Response>;

export type OauthAccountsSlice = {
  accounts: OauthAccount[];
  loading: boolean;
  lastRefreshAt: number;
  hydrated: boolean;
};

const EMPTY_SLICE: OauthAccountsSlice = Object.freeze({
  accounts: [],
  loading: false,
  lastRefreshAt: 0,
  hydrated: false,
});

type Listener = () => void;

const slices = new Map<string, OauthAccountsSlice>();
const inflight = new Map<string, Promise<OauthAccount[] | null>>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function oauthAccountsStoreKey(providerId: string | null | undefined): string {
  const raw = typeof providerId === 'string' ? providerId.trim() : '';
  if (raw === 'openai-codex-oauth' || raw === 'openai-codex') return 'openai-codex';
  return raw;
}

export function subscribeOauthAccounts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function peekOauthAccountsSlice(providerId: string | null | undefined): OauthAccountsSlice {
  const key = oauthAccountsStoreKey(providerId);
  if (!key) return EMPTY_SLICE;
  return slices.get(key) || EMPTY_SLICE;
}

export function resetOauthAccountsStore(): void {
  slices.clear();
  inflight.clear();
  emit();
}

export function mergeOauthAccountList(previous: OauthAccount[], next: OauthAccount[]): OauthAccount[] {
  if (previous.length === 0) return next;
  return next.map((account) => {
    const prior = previous.find((item) => item.id === account.id);
    if (!prior?.usage) return account;
    return { ...account, usage: mergeAccountUsage(prior.usage, account.usage) || account.usage };
  });
}

export function applyOauthAccounts(providerId: string, accounts: OauthAccount[], merge = true): void {
  const key = oauthAccountsStoreKey(providerId);
  if (!key) return;
  const prev = slices.get(key) || EMPTY_SLICE;
  writeSlice(key, {
    accounts: merge ? mergeOauthAccountList(prev.accounts, accounts) : accounts,
    loading: false,
    hydrated: true,
  });
}

export function applyOauthAccountsPayload(data: { provider?: unknown; accounts?: unknown } | null | undefined): void {
  const provider = typeof data?.provider === 'string' ? data.provider : '';
  if (!provider || !Array.isArray(data?.accounts)) return;
  const accounts = data.accounts
    .map(normalizeOauthAccount)
    .filter((account): account is OauthAccount => !!account);
  applyOauthAccounts(provider, accounts);
}

export function publishOauthAccountsChanged(data: { provider?: unknown; accounts?: unknown } | null | undefined): void {
  applyOauthAccountsPayload(data);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OAUTH_ACCOUNTS_CHANGED_EVENT, { detail: data || {} }));
  }
}

export function seedOauthAccountsIfEmpty(providerId: string, seed: OauthAccount[]): void {
  const key = oauthAccountsStoreKey(providerId);
  if (!key || seed.length === 0) return;
  const prev = slices.get(key);
  if (prev && prev.accounts.length > 0) return;
  writeSlice(key, { accounts: seed, loading: prev?.loading ?? seed.length === 0 });
}

export async function requestOauthAccounts(
  providerId: string,
  fetchImpl: OauthAccountsFetch,
  { refresh = false, force = false }: { refresh?: boolean; force?: boolean } = {},
): Promise<OauthAccount[] | null> {
  const key = oauthAccountsStoreKey(providerId);
  if (!key) return null;
  const inflightKey = `${key}:${refresh ? 'refresh' : 'cache'}`;
  const pending = inflight.get(inflightKey);
  if (pending) return pending;

  if (refresh && !force) {
    const lastRefreshAt = slices.get(key)?.lastRefreshAt || 0;
    if (lastRefreshAt && Date.now() - lastRefreshAt < OAUTH_ACCOUNTS_MIN_REFRESH_GAP_MS) {
      return slices.get(key)?.accounts ?? [];
    }
  }

  const work = (async () => {
    const prev = slices.get(key) || EMPTY_SLICE;
    if (prev.accounts.length === 0) writeSlice(key, { loading: true });
    try {
      const suffix = refresh ? '?refresh=1' : '';
      const res = await fetchImpl(`/api/auth/oauth/${encodeURIComponent(providerId)}/accounts${suffix}`);
      const data = await res.json() as { accounts?: unknown };
      const accounts = Array.isArray(data.accounts)
        ? data.accounts.map(normalizeOauthAccount).filter((account): account is OauthAccount => !!account)
        : [];
      writeSlice(key, {
        accounts: mergeOauthAccountList(prev.accounts, accounts),
        loading: false,
        hydrated: true,
        lastRefreshAt: refresh ? Date.now() : prev.lastRefreshAt,
      });
      return accounts;
    } catch {
      writeSlice(key, { loading: false });
      return null;
    }
  })();

  inflight.set(inflightKey, work);
  try {
    return await work;
  } finally {
    if (inflight.get(inflightKey) === work) inflight.delete(inflightKey);
  }
}

function writeSlice(key: string, patch: Partial<OauthAccountsSlice>): void {
  const prev = slices.get(key) || EMPTY_SLICE;
  const next: OauthAccountsSlice = {
    accounts: patch.accounts ?? prev.accounts,
    loading: patch.loading ?? prev.loading,
    lastRefreshAt: patch.lastRefreshAt ?? prev.lastRefreshAt,
    hydrated: patch.hydrated ?? prev.hydrated,
  };
  if (
    prev !== EMPTY_SLICE
    && prev.accounts === next.accounts
    && prev.loading === next.loading
    && prev.lastRefreshAt === next.lastRefreshAt
    && prev.hydrated === next.hydrated
  ) {
    return;
  }
  slices.set(key, next);
  emit();
}
