import { useCallback, useMemo, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { invalidateCodexServiceTier } from '../../hooks/use-codex-service-tier';
import { useOauthAccounts } from '../../hooks/use-oauth-accounts';
import { useI18n } from '../../hooks/use-i18n';
import {
  formatOauthAccountIdentity,
  formatOauthAccountLabel,
  formatOauthAccountMeta,
  formatOauthAccountShort,
  formatOauthRemaining,
  type OauthAccount,
  type OauthAccountProviderId,
} from '../../utils/oauth-account';
import { SelectWidget, type SelectOption } from '@/ui';
import styles from './InputArea.module.css';

export function OauthAccountButton({
  providerId,
  isStreaming = false,
}: {
  providerId: OauthAccountProviderId;
  isStreaming?: boolean;
}) {
  const { t } = useI18n();
  const { accounts, applyAccounts, refresh } = useOauthAccounts(providerId, {
    fetch: hanaFetch,
    isStreaming,
  });
  const [saving, setSaving] = useState(false);

  const active = accounts.find(account => account.active) || accounts[0] || null;
  const remaining = formatOauthRemaining(active?.usage);
  const tOr = (key: string, fallback: string, vars?: Record<string, string>) => {
    const value = (t as (path: string, params?: Record<string, string>) => string)(key, vars);
    return value !== key ? value : fallback;
  };
  const label = tOr('input.oauthAccountLabel', 'Account');
  const triggerText = remaining == null
    ? tOr('input.oauthQuotaUnknown', '额度 —')
    : tOr('input.oauthRemaining', `余 ${remaining}%`, { remaining: String(remaining) });
  const short = formatOauthAccountShort(active);
  const options: SelectOption[] = useMemo(() => accounts.map(account => ({
    value: account.id,
    label: formatOauthAccountLabel(account),
    description: formatOauthAccountMeta(account),
  })), [accounts]);

  const selectAccount = useCallback(async (id: string) => {
    if (!id || id === active?.id || saving) return;
    setSaving(true);
    try {
      const res = await hanaFetch(`/api/auth/oauth/${encodeURIComponent(providerId)}/accounts/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json() as { accounts?: OauthAccount[] };
      if (Array.isArray(data.accounts)) applyAccounts(data.accounts);
      if (res.ok) invalidateCodexServiceTier({ resetEligibility: true });
    } catch (err) {
      console.error('[oauth-account] switch failed:', err);
    } finally {
      setSaving(false);
    }
  }, [active?.id, applyAccounts, providerId, saving]);

  if (accounts.length === 0) return null;

  const low = remaining != null && remaining <= 15;

  return (
    <SelectWidget
      className={`${styles['thinking-selector']} ${styles['oauth-account-selector']}`}
      options={options}
      value={active?.id || ''}
      onChange={selectAccount}
      disabled={saving}
      align="end"
      placement="top"
      offset={4}
      popupMinWidth={260}
      triggerBare
      triggerAriaLabel={label}
      triggerTitle={[label, short, triggerText, active ? formatOauthAccountIdentity(active) : ''].filter(Boolean).join(' · ')}
      triggerClassName={`${styles['thinking-pill']} ${styles['oauth-account-pill']}${low ? ` ${styles.active}` : ''}`}
      onAttemptOpen={() => {
        void refresh(true);
        invalidateCodexServiceTier();
        return true;
      }}
      renderTrigger={() => (
        <span className={styles['oauth-account-trigger']}>
          {short ? <span className={styles['oauth-account-name']}>{short}</span> : null}
          <span className={styles['oauth-account-remaining']}>{triggerText}</span>
        </span>
      )}
      renderOption={(option, selected) => {
        const account = accounts.find(item => item.id === option.value);
        const meta = account ? formatOauthAccountMeta(account) : option.description;
        return (
          <span className={styles['oauth-account-option']}>
            <span>{selected ? '● ' : ''}{option.label}</span>
            {meta ? <span className={styles['oauth-account-option-meta']}>{meta}</span> : null}
          </span>
        );
      }}
    />
  );
}
