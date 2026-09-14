import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  applyOauthAccounts,
  oauthAccountsStoreKey,
  peekOauthAccountsSlice,
  requestOauthAccounts,
  seedOauthAccountsIfEmpty,
  subscribeOauthAccounts,
  type OauthAccountsFetch,
  type OauthAccountsSlice,
} from '../stores/oauth-accounts-store';
import type { OauthAccount } from '../utils/oauth-account';

const EMPTY_SLICE: OauthAccountsSlice = {
  accounts: [],
  loading: false,
  lastRefreshAt: 0,
  hydrated: false,
};

export function useOauthAccounts(
  providerId: string | null | undefined,
  options: {
    fetch: OauthAccountsFetch;
    seed?: OauthAccount[];
    refreshEpoch?: number;
    isStreaming?: boolean;
  },
): {
  accounts: OauthAccount[];
  loading: boolean;
  refresh: (force?: boolean) => Promise<OauthAccount[] | null>;
  applyAccounts: (accounts: OauthAccount[]) => void;
} {
  const key = oauthAccountsStoreKey(providerId);
  const fetchImpl = options.fetch;
  const seed = options.seed;
  const refreshEpoch = options.refreshEpoch;
  const isStreaming = options.isStreaming;
  const slice = useSyncExternalStore(
    subscribeOauthAccounts,
    () => (key ? peekOauthAccountsSlice(key) : EMPTY_SLICE),
    () => EMPTY_SLICE,
  );

  useEffect(() => {
    if (!key || !providerId) return;
    if (seed?.length) seedOauthAccountsIfEmpty(key, seed);
    let cancelled = false;
    void (async () => {
      await requestOauthAccounts(providerId, fetchImpl, { refresh: false });
      if (cancelled) return;
      await requestOauthAccounts(providerId, fetchImpl, { refresh: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, key, providerId]);

  useEffect(() => {
    if (!key || !providerId || !refreshEpoch) return;
    void requestOauthAccounts(providerId, fetchImpl, { refresh: true, force: true });
  }, [fetchImpl, key, providerId, refreshEpoch]);

  const wasStreaming = useRef(!!isStreaming);
  useEffect(() => {
    if (!key || !providerId) {
      wasStreaming.current = !!isStreaming;
      return;
    }
    if (wasStreaming.current && !isStreaming) {
      void requestOauthAccounts(providerId, fetchImpl, { refresh: true, force: true });
    }
    wasStreaming.current = !!isStreaming;
  }, [fetchImpl, isStreaming, key, providerId]);

  useEffect(() => {
    if (!key || !providerId) return;
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void requestOauthAccounts(providerId, fetchImpl, { refresh: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [fetchImpl, key, providerId]);

  const refresh = useCallback((force = false) => {
    if (!providerId) return Promise.resolve(null);
    return requestOauthAccounts(providerId, fetchImpl, { refresh: true, force });
  }, [fetchImpl, providerId]);

  const applyAccounts = useCallback((accounts: OauthAccount[]) => {
    if (!providerId) return;
    applyOauthAccounts(providerId, accounts);
  }, [providerId]);

  const accounts = !key
    ? []
    : slice.hydrated || slice.accounts.length > 0
      ? slice.accounts
      : (seed ?? []);

  return {
    accounts,
    loading: !!key && !slice.hydrated && accounts.length === 0 && (slice.loading || !seed?.length),
    refresh,
    applyAccounts,
  };
}
