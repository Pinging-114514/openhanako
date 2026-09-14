import { isCodexOauthProvider } from '../../../../shared/codex-service-tier.ts';
import {
  isOauthUsageError,
  mergeOauthUsageSnapshot,
  publicOauthUsage,
  type OauthUsageError,
  type OauthUsageSnapshot,
} from '../../../../shared/oauth-usage.ts';

export type OauthAccountProviderId = 'openai-codex-oauth' | 'openai-codex' | 'xai-oauth';
export type { OauthUsageError, OauthUsageSnapshot };

export interface OauthAccountUsage {
  ok?: boolean;
  remaining?: number | null;
  resetAt?: string | null;
  planType?: string | null;
  windowKind?: 'week' | 'hours' | 'window';
  windowSeconds?: number | null;
  error?: OauthUsageError | null;
  stale?: boolean;
}

export type OauthUsageTone = 'ok' | 'warn' | 'error' | 'muted';

export type OauthUsageDescription = {
  text: string;
  tone: OauthUsageTone;
};

export interface OauthAccount {
  id: string;
  accountId: string;
  email: string;
  displayName: string;
  shortLabel: string;
  active: boolean;
  usage: OauthAccountUsage | null;
}

export function isOauthAccountProvider(provider: string | null | undefined): provider is OauthAccountProviderId {
  return isCodexOauthProvider(provider) || provider === 'xai-oauth';
}

export function resolveOauthAccountProvider(
  sessionModel?: { provider?: string; id?: string } | null,
  models: readonly { provider?: string; id?: string; isCurrent?: boolean }[] = [],
): OauthAccountProviderId | null {
  const current = sessionModel?.id || sessionModel?.provider
    ? sessionModel
    : models.find((model) => model.isCurrent);
  if (isOauthAccountProvider(current?.provider)) return current.provider;
  if (!current?.id) return null;
  const matched = models.find((model) => (
    model.id === current.id
    && (!current.provider || !model.provider || model.provider === current.provider)
  ));
  return isOauthAccountProvider(matched?.provider) ? matched.provider : null;
}

export const PENDING_OAUTH_ACCOUNT_ID = '__pending__';

export function countSavedOauthAccounts(accounts: OauthAccount[] | null | undefined): number {
  return (accounts || []).filter(account => account.id !== PENDING_OAUTH_ACCOUNT_ID).length;
}

export function normalizeOauthAccount(raw: unknown): OauthAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  const usage = item.usage && typeof item.usage === 'object' ? item.usage as OauthAccountUsage : null;
  return {
    id: item.id.trim(),
    accountId: typeof item.accountId === 'string' ? item.accountId : '',
    email: typeof item.email === 'string' ? item.email : '',
    displayName: typeof item.displayName === 'string' ? item.displayName : '',
    shortLabel: typeof item.shortLabel === 'string' ? item.shortLabel : '',
    active: item.active === true,
    usage,
  };
}

export function seedOauthAccountsFromSummary(summary: {
  oauth_accounts?: unknown;
  oauth_usage?: OauthAccountUsage | null;
  logged_in?: boolean;
} | null | undefined): OauthAccount[] {
  const accounts = Array.isArray(summary?.oauth_accounts)
    ? summary.oauth_accounts.map(normalizeOauthAccount).filter((account): account is OauthAccount => !!account)
    : [];
  const usage = summary?.oauth_usage || null;
  if (!usage) return accounts;
  return accounts.map((account) => {
    if (!account.active || formatOauthRemaining(account.usage) != null) return account;
    return { ...account, usage: { ...account.usage, ...usage } };
  });
}

export function reservedOauthAccount(summary: {
  oauth_usage?: OauthAccountUsage | null;
  logged_in?: boolean;
} | null | undefined): OauthAccount | null {
  if (!summary?.logged_in) return null;
  return {
    id: PENDING_OAUTH_ACCOUNT_ID,
    accountId: '',
    email: '',
    displayName: '',
    shortLabel: '',
    active: true,
    usage: summary.oauth_usage || null,
  };
}

export function formatOauthRemaining(usage: OauthAccountUsage | null | undefined): number | null {
  return typeof usage?.remaining === 'number' && (usage.ok || usage.stale) ? usage.remaining : null;
}

export function normalizeOauthUsage(raw: unknown): OauthAccountUsage | null {
  return publicOauthUsage(raw);
}

export function mergeAccountUsage(
  previous: OauthAccountUsage | null | undefined,
  next: OauthAccountUsage | null | undefined,
): OauthAccountUsage | null {
  return mergeOauthUsageSnapshot(previous, next);
}

export function describeOauthUsage(
  usage: OauthAccountUsage | null | undefined,
  t: (key: string, params?: Record<string, string>) => string,
): OauthUsageDescription | null {
  if (!usage) return null;
  const remaining = typeof usage.remaining === 'number' ? usage.remaining : null;
  const remainingText = remaining == null
    ? ''
    : remaining <= 0
      ? t('settings.oauth.weeklyExhausted')
      : usage.windowKind === 'hours'
        ? t('settings.oauth.hoursRemaining', {
          hours: String(Math.max(1, Math.round((usage.windowSeconds || 18000) / 3600))),
          remaining: String(remaining),
        })
        : t('settings.oauth.weeklyRemaining', { remaining: String(remaining) });

  if (usage.error === 'auth_revoked') {
    return { text: t('settings.oauth.weeklyRevoked'), tone: 'error' };
  }
  if (usage.error === 'not_logged_in') {
    return { text: t('settings.oauth.weeklyNotLoggedIn'), tone: 'muted' };
  }
  if (usage.ok && remainingText) {
    return { text: remainingText, tone: remaining != null && remaining <= 0 ? 'warn' : 'ok' };
  }
  if (remainingText && (usage.stale || isOauthUsageError(usage.error))) {
    return { text: `${remainingText} · ${t('settings.oauth.weeklyRefreshFailed')}`, tone: 'warn' };
  }
  if (usage.error === 'network') return { text: t('settings.oauth.weeklyNetwork'), tone: 'warn' };
  if (usage.error === 'rate_limited') return { text: t('settings.oauth.weeklyRateLimited'), tone: 'warn' };
  if (usage.error === 'upstream') return { text: t('settings.oauth.weeklyUpstream'), tone: 'warn' };
  return { text: t('settings.oauth.weeklyUnknown'), tone: 'muted' };
}

export function formatOauthAccountIdentity(account: Pick<OauthAccount, 'email' | 'displayName' | 'shortLabel' | 'accountId'>): string {
  if (isEmailish(account.email)) return account.email;
  if (isEmailish(account.displayName)) return account.displayName;
  if (account.displayName && !looksLikeOpaqueId(account.displayName)) return account.displayName;
  if (account.shortLabel && !looksLikeOpaqueId(account.shortLabel)) return account.shortLabel;
  return '';
}

export function formatOauthAccountLabel(account: OauthAccount): string {
  return formatOauthAccountIdentity(account);
}

export function formatOauthAccountShort(account: OauthAccount | null | undefined): string {
  if (!account) return '';
  const identity = formatOauthAccountIdentity(account);
  if (isEmailish(identity)) {
    const local = identity.slice(0, identity.indexOf('@')).trim();
    return local.length > 12 ? local.slice(0, 12) : local;
  }
  if (account.shortLabel && !looksLikeOpaqueId(account.shortLabel)) return account.shortLabel;
  return identity;
}

export function formatOauthAccountMeta(account: OauthAccount): string {
  const remaining = formatOauthRemaining(account.usage);
  const plan = typeof account.usage?.planType === 'string' ? account.usage.planType.trim() : '';
  return [plan, remaining == null ? '' : `${remaining}%`].filter(Boolean).join(' · ');
}

function isEmailish(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes('@');
}

function looksLikeOpaqueId(value: string): boolean {
  const raw = value.trim();
  if (!raw || raw.includes('@')) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return true;
  }
  return /^[0-9a-f]{8,}$/i.test(raw);
}
