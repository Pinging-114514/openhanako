import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { useOauthAccounts } from '../../../hooks/use-oauth-accounts';
import { DEFAULT_OAUTH_LOGIN_METHOD } from '../../../../../../shared/oauth-login.ts';
import { isCodexOauthProvider } from '../../../../../../shared/codex-service-tier.ts';
import { invalidateCodexServiceTier, useCodexServiceTier } from '../../../hooks/use-codex-service-tier';
import {
  countSavedOauthAccounts,
  describeOauthUsage,
  formatOauthAccountLabel,
  formatOauthAccountMeta,
  isOauthAccountProvider,
  mergeAccountUsage,
  normalizeOauthUsage,
  PENDING_OAUTH_ACCOUNT_ID,
  reservedOauthAccount,
  seedOauthAccountsFromSummary,
  type OauthAccount,
  type OauthAccountUsage,
} from '../../../utils/oauth-account';
import { Toggle } from '@/ui';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function OAuthCredentials({ providerId, summary, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  onRefresh: () => Promise<void>;
}) {
  const showToast = useSettingsStore(s => s.showToast);
  const [codeInput, setCodeInput] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const pollingRef = useRef(false);
  const oauthSessionIdRef = useRef<string | null>(null);
  const accountSeed = useMemo(() => seedOauthAccountsFromSummary(summary), [
    summary.oauth_accounts,
    summary.oauth_usage,
    summary.logged_in,
  ]);
  const { accounts, loading: accountsLoading, applyAccounts } = useOauthAccounts(
    isOauthAccountProvider(providerId) ? providerId : null,
    {
      fetch: hanaFetch,
      seed: accountSeed,
      refreshEpoch: accountEpoch,
    },
  );
  const hideSharedWeeklyUsage = countSavedOauthAccounts(accounts) >= 2;

  const login = async () => {
    try {
      const res = await hanaFetch('/api/auth/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerId,
          loginMethod: DEFAULT_OAUTH_LOGIN_METHOD,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      platform?.openExternal?.(data.url);
      if (data.instructions) {
        setDeviceCode(data.instructions);
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else if (data.polling) {
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else {
        setShowCodeInput(true);
        oauthSessionIdRef.current = data.sessionId;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  const submitCode = async () => {
    const code = codeInput.trim();
    if (!code) return;
    try {
      const res = await hanaFetch('/api/auth/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: oauthSessionIdRef.current, code }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.oauth.success'), 'success');
      setShowCodeInput(false);
      invalidateCodexServiceTier({ resetEligibility: true });
      await onRefresh();
      setAccountEpoch(value => value + 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  const pollLogin = async (sessionId: string) => {
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (!pollingRef.current) return;
      try {
        const res = await hanaFetch(`/api/auth/oauth/poll/${sessionId}`);
        const data = await res.json();
        if (data.status === 'done') {
          showToast(t('settings.oauth.success'), 'success');
          setDeviceCode(null);
          setPolling(false);
          pollingRef.current = false;
          invalidateCodexServiceTier({ resetEligibility: true });
          await onRefresh();
          setAccountEpoch(value => value + 1);
          return;
        }
        if (data.status === 'error') throw new Error(data.error || 'Login failed');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
        setDeviceCode(null);
        setPolling(false);
        pollingRef.current = false;
        return;
      }
    }
    setDeviceCode(null);
    setPolling(false);
    pollingRef.current = false;
  };

  const logout = async () => {
    invalidateCodexServiceTier({ resetEligibility: true });
    try {
      await hanaFetch('/api/auth/oauth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      showToast(t('settings.oauth.loggedOut'), 'success');
      invalidateCodexServiceTier({ resetEligibility: true });
      await onRefresh();
      setAccountEpoch(value => value + 1);
      invalidateCodexServiceTier({ resetEligibility: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  return (
    <div className={styles['pv-credentials']}>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>OAuth</span>
        {summary.logged_in ? (
          <div className={styles['pv-oauth-status']}>
            <span className={styles['oauth-status-badge']}>{t('settings.oauth.loggedIn')}</span>
            {isOauthAccountProvider(providerId) && (
              <button className={styles['oauth-login-btn']} onClick={login}>{t('settings.oauth.addAccount')}</button>
            )}
            <button className={styles['oauth-logout-btn']} onClick={logout}>{t('settings.oauth.logout')}</button>
          </div>
        ) : (
          <button className={styles['oauth-login-btn']} onClick={login}>{t('settings.oauth.login')}</button>
        )}
      </div>
      {isOauthAccountProvider(providerId) && (
        <OauthAccountManager
          providerId={providerId}
          summary={summary}
          accounts={accounts}
          loading={accountsLoading}
          applyAccounts={applyAccounts}
          onRefresh={onRefresh}
        />
      )}
      {providerId === 'xai-oauth' && (
        <>
          {summary.logged_in && !hideSharedWeeklyUsage && (
            <XaiOauthWeeklyUsage summary={summary} accounts={accounts} />
          )}
          <XaiOauthSearchToolsToggle />
        </>
      )}
      {isCodexOauthProvider(providerId) && summary.logged_in && !hideSharedWeeklyUsage && (
        <CodexOauthUsage providerId={providerId} summary={summary} accounts={accounts} />
      )}
      {isCodexOauthProvider(providerId) && summary.logged_in && (
        <CodexOauthSpeedControl />
      )}

      {showCodeInput && (
        <div className={styles['oauth-code-section']}>
          <input
            className={`${styles['settings-input']} ${styles['oauth-code-input']}`}
            type="text"
            placeholder={t('settings.oauth.codePlaceholder')}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCode(); }}
            autoFocus
          />
          <button className={styles['oauth-code-submit']} onClick={submitCode}>{t('settings.oauth.submit')}</button>
        </div>
      )}
      {deviceCode && (
        <div className={`${styles['oauth-code-section']} ${styles['oauth-device-code']}`}>
          <div
            className={styles['oauth-user-code']}
            title={t('settings.oauth.clickToCopy')}
            onClick={() => navigator.clipboard.writeText(deviceCode).then(() => useSettingsStore.getState().showToast(t('settings.oauth.codeCopied'), 'success'))}
          >
            {deviceCode}
          </div>
          <div className={styles['oauth-device-hint']}>{t('settings.oauth.deviceHint')}</div>
          <div className={styles['oauth-device-spinner']}>{t('settings.oauth.waiting')}</div>
        </div>
      )}
      {polling && !deviceCode && !showCodeInput && (
        <div className={styles['oauth-code-section']}>
          <div className={styles['oauth-device-spinner']}>{t('settings.oauth.waiting')}</div>
        </div>
      )}
    </div>
  );
}

function OauthAccountManager({ providerId, summary, accounts, loading, applyAccounts, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  accounts: OauthAccount[];
  loading: boolean;
  applyAccounts: (accounts: OauthAccount[]) => void;
  onRefresh: () => Promise<void>;
}) {
  const showToast = useSettingsStore(s => s.showToast);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activate = async (id: string) => {
    setBusyId(id);
    try {
      const res = await hanaFetch(`/api/auth/oauth/${encodeURIComponent(providerId)}/accounts/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json() as { accounts?: OauthAccount[]; error?: string };
      if (data.error) throw new Error(data.error);
      if (Array.isArray(data.accounts)) applyAccounts(data.accounts);
      if (res.ok) invalidateCodexServiceTier({ resetEligibility: true });
      await onRefresh();
    } catch (err: unknown) {
      showToast(t('settings.oauth.failed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      const res = await hanaFetch(`/api/auth/oauth/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json() as { accounts?: OauthAccount[]; error?: string };
      if (data.error) throw new Error(data.error);
      if (Array.isArray(data.accounts)) applyAccounts(data.accounts);
      if (res.ok) invalidateCodexServiceTier({ resetEligibility: true });
      await onRefresh();
    } catch (err: unknown) {
      showToast(t('settings.oauth.failed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const visible = accounts.length > 0
    ? accounts
    : loading
      ? [reservedOauthAccount(summary)].filter((account): account is OauthAccount => !!account)
      : [];
  if (visible.length === 0) return null;

  return (
    <div className={styles['oauth-account-list']} data-testid="oauth-account-list">
      {visible.map((account) => {
        const pending = account.id === PENDING_OAUTH_ACCOUNT_ID;
        const label = formatOauthAccountLabel(account);
        const revoked = account.usage?.error === 'auth_revoked';
        const described = describeOauthUsage(account.usage, t);
        const statusLabel = revoked
          ? t('settings.oauth.accountInvalid')
          : account.active
            ? t('settings.oauth.activeAccount')
            : '';
        const usageMeta = formatOauthAccountMeta(account) || described?.text || '';
        return (
          <div key={account.id} className={styles['oauth-account-row']}>
            <div className={styles['oauth-account-row-copy']}>
              <div className={styles['oauth-account-row-name']}>
                {label}
                {statusLabel ? `${label ? ' · ' : ''}${statusLabel}` : ''}
              </div>
              <div className={styles['oauth-account-row-meta']}>
                {usageMeta || (pending ? '' : t('settings.oauth.quotaUnknown'))}
              </div>
            </div>
            {!pending && (
              <div className={styles['oauth-account-row-actions']}>
                {!account.active && (
                  <button
                    type="button"
                    className={styles['oauth-login-btn']}
                    disabled={busyId === account.id}
                    onClick={() => activate(account.id)}
                  >
                    {t('settings.oauth.useAccount')}
                  </button>
                )}
                <button
                  type="button"
                  className={styles['oauth-logout-btn']}
                  disabled={busyId === account.id}
                  onClick={() => remove(account.id)}
                >
                  {t('settings.oauth.removeAccount')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatResetWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function readOauthUsage(url: string): Promise<OauthAccountUsage | null> {
  try {
    const res = await hanaFetch(url);
    const data = await res.json();
    return normalizeOauthUsage(data);
  } catch {
    return null;
  }
}

async function readXaiOauthUsage(): Promise<OauthAccountUsage | null> {
  let last: OauthAccountUsage | null = null;
  for (const url of ['/api/auth/oauth/xai-oauth/usage', '/api/plugins/xai-native-search/usage']) {
    const usage = await readOauthUsage(url);
    if (usage?.ok && typeof usage.remaining === 'number') return usage;
    if (usage) last = usage;
  }
  return last || { ok: false, remaining: null, error: 'unavailable' };
}

function formatPlanType(planType: string | null | undefined): string {
  const raw = String(planType || '').trim();
  if (!raw) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

async function readCodexOauthUsage(providerId: string): Promise<OauthAccountUsage | null> {
  return await readOauthUsage(`/api/auth/oauth/${encodeURIComponent(providerId)}/usage`)
    || { ok: false, remaining: null, error: 'unavailable' };
}

function usageFromSummary(summary: ProviderSummary): OauthAccountUsage | null {
  return normalizeOauthUsage(summary.oauth_usage);
}

function OauthWeeklyUsageLine({ usage }: { usage: OauthAccountUsage | null }) {
  const described = describeOauthUsage(usage, t);
  const reset = described && described.tone !== 'error' && described.tone !== 'muted'
    ? formatResetWhen(usage?.resetAt ?? null)
    : '';
  const plan = described?.tone === 'ok' || described?.tone === 'warn'
    ? formatPlanType(usage?.planType)
    : '';
  const text = described
    ? [plan, described.text, reset ? t('settings.oauth.weeklyReset', { when: reset }) : '']
      .filter(Boolean)
      .join(' · ')
    : '';
  const tone = described?.tone || 'muted';

  return (
    <div
      className={`${styles['oauth-weekly-usage']} ${styles[`oauth-weekly-usage-${tone}`] || ''}`}
      data-testid="oauth-weekly-usage"
    >
      {text}
    </div>
  );
}

function activeAccountUsage(accounts: OauthAccount[]): OauthAccountUsage | null {
  return accounts.find((account) => account.active)?.usage || accounts[0]?.usage || null;
}

function CodexOauthUsage({
  providerId,
  summary,
  accounts,
}: {
  providerId: string;
  summary: ProviderSummary;
  accounts: OauthAccount[];
}) {
  const fromAccounts = activeAccountUsage(accounts);
  const [usage, setUsage] = useState<OauthAccountUsage | null>(
    () => fromAccounts || usageFromSummary(summary),
  );

  useEffect(() => {
    if (fromAccounts) {
      setUsage((prev) => mergeAccountUsage(prev, fromAccounts) || fromAccounts);
      return;
    }
    const fromSummary = usageFromSummary(summary);
    if (fromSummary) {
      setUsage((prev) => mergeAccountUsage(prev, fromSummary) || fromSummary);
      return;
    }
    let cancelled = false;
    readCodexOauthUsage(providerId).then((next) => {
      if (cancelled) return;
      if (next) setUsage((prev) => mergeAccountUsage(prev, next) || next);
      invalidateCodexServiceTier({ planType: next?.planType ?? null });
    });
    return () => {
      cancelled = true;
    };
  }, [fromAccounts, providerId, summary.oauth_usage]);

  return <OauthWeeklyUsageLine usage={usage} />;
}

function CodexOauthSpeedControl() {
  const speed = useCodexServiceTier((path, init) => {
    const { throwOnHttpError: _ignored, ...rest } = init || {};
    return hanaFetch(path, rest);
  });
  const label = t('settings.oauth.codexSpeed');
  return (
    <div className={styles['oauth-search-tools']} data-testid="codex-speed-settings">
      <div className={styles['oauth-search-tools-row']}>
        <span className={styles['oauth-search-tools-label']}>{label}</span>
        <select
          className={`${styles['settings-input']} ${styles['oauth-speed-select']}`}
          aria-label={label}
          value={speed.selectValue}
          disabled={speed.loading || speed.saving || speed.downgradeUnconfirmed}
          onChange={(event) => { void speed.selectTier(event.target.value); }}
        >
          {speed.downgradeUnconfirmed && (
            <option value="">{t('settings.oauth.codexSpeedUnconfirmed')}</option>
          )}
          {speed.options.map((option) => (
            <option key={option} value={option}>{t(`settings.api.codexSpeed.${option}`)}</option>
          ))}
        </select>
      </div>
      <div className={styles['oauth-search-tools-hint']}>
        {speed.downgradeUnconfirmed
          ? t('settings.oauth.codexSpeedUnconfirmed')
          : t('settings.oauth.codexSpeedHint')}
      </div>
    </div>
  );
}

function XaiOauthWeeklyUsage({
  summary,
  accounts,
}: {
  summary: ProviderSummary;
  accounts: OauthAccount[];
}) {
  const fromAccounts = activeAccountUsage(accounts);
  const [usage, setUsage] = useState<OauthAccountUsage | null>(
    () => fromAccounts || usageFromSummary(summary),
  );

  useEffect(() => {
    if (fromAccounts) {
      setUsage((prev) => mergeAccountUsage(prev, fromAccounts) || fromAccounts);
      return;
    }
    const fromSummary = usageFromSummary(summary);
    if (fromSummary) {
      setUsage((prev) => mergeAccountUsage(prev, fromSummary) || fromSummary);
      return;
    }
    let cancelled = false;
    readXaiOauthUsage().then((next) => {
      if (!cancelled && next) setUsage((prev) => mergeAccountUsage(prev, next) || next);
    });
    return () => {
      cancelled = true;
    };
  }, [fromAccounts, summary.oauth_usage]);

  return <OauthWeeklyUsageLine usage={usage} />;
}

function XaiOauthSearchToolsToggle() {
  const showToast = useSettingsStore(s => s.showToast);
  const snapshotEnabled = useSettingsStore(s => s.settingsSnapshot?.data?.preferences?.xaiOauthSearch?.enabled);
  const [enabled, setEnabled] = useState<boolean | undefined>(
    typeof snapshotEnabled === 'boolean' ? snapshotEnabled : undefined,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void hanaFetch('/api/preferences/xai-oauth-search')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.enabled === 'boolean') setEnabled(data.enabled);
        else setEnabled(true);
      })
      .catch(() => {
        if (!cancelled) setEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = async (on: boolean) => {
    const previous = enabled;
    setEnabled(on);
    setSaving(true);
    try {
      const res = await hanaFetch('/api/preferences/xai-oauth-search', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
      if (typeof data.enabled === 'boolean') setEnabled(data.enabled);
    } catch (err: unknown) {
      setEnabled(previous);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles['oauth-search-tools']}>
      <div className={styles['oauth-search-tools-row']}>
        <span className={styles['oauth-search-tools-label']}>{t('settings.oauth.searchTools')}</span>
        <Toggle
          on={enabled}
          onChange={handleChange}
          disabled={saving}
          ariaLabel={t('settings.oauth.searchTools')}
        />
      </div>
      <div className={styles['oauth-search-tools-hint']}>{t('settings.oauth.searchToolsHint')}</div>
    </div>
  );
}
