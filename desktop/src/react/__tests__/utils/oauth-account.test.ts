import { describe, expect, it } from 'vitest';
import {
  countSavedOauthAccounts,
  describeOauthUsage,
  formatOauthAccountIdentity,
  formatOauthAccountMeta,
  formatOauthAccountShort,
  PENDING_OAUTH_ACCOUNT_ID,
  reservedOauthAccount,
  seedOauthAccountsFromSummary,
  type OauthAccount,
} from '../../utils/oauth-account';

const grokUuid: OauthAccount = {
  id: 'acc-1',
  accountId: '8fcc46b9-2ef3-4ab2-8c24-1414b32b138e',
  email: '',
  displayName: 'b32b138e',
  shortLabel: 'b32b138e',
  active: true,
  usage: { ok: true, remaining: 81 },
};

describe('oauth account display', () => {
  it('uses email and never falls back to a UUID', () => {
    const account: OauthAccount = {
      ...grokUuid,
      email: 'grok.user@x.ai',
      displayName: 'grok.user@x.ai',
      shortLabel: 'grok.user',
    };
    expect(formatOauthAccountIdentity(account)).toBe('grok.user@x.ai');
    expect(formatOauthAccountMeta(account)).toBe('81%');
    expect(formatOauthAccountShort(account)).toBe('grok.user');
  });

  it('hides leftover UUID labels when email is missing', () => {
    expect(formatOauthAccountIdentity(grokUuid)).toBe('');
    expect(formatOauthAccountMeta(grokUuid)).toBe('81%');
    expect(formatOauthAccountMeta({ ...grokUuid, usage: { ok: true, remaining: 81, planType: 'heavy' } })).toBe('heavy · 81%');
    expect(formatOauthAccountShort(grokUuid)).toBe('');
  });

  it('seeds accounts from the provider summary and fills missing active quota', () => {
    expect(seedOauthAccountsFromSummary({
      oauth_accounts: [{
        id: 'acc-1',
        accountId: 'acct-work',
        email: 'work@example.com',
        displayName: 'work@example.com',
        shortLabel: 'work',
        active: true,
        usage: null,
      }],
      oauth_usage: { ok: true, remaining: 42, planType: 'plus' },
    })).toEqual([
      expect.objectContaining({
        id: 'acc-1',
        email: 'work@example.com',
        usage: expect.objectContaining({ remaining: 42, planType: 'plus' }),
      }),
    ]);
  });

  it('reserves a logged-in placeholder without inventing an email', () => {
    expect(reservedOauthAccount({
      logged_in: true,
      oauth_usage: { ok: true, remaining: 81 },
    })).toEqual({
      id: PENDING_OAUTH_ACCOUNT_ID,
      accountId: '',
      email: '',
      displayName: '',
      shortLabel: '',
      active: true,
      usage: { ok: true, remaining: 81 },
    });
    expect(reservedOauthAccount({ logged_in: false })).toBeNull();
  });

  it('does not count the pending placeholder as a saved account', () => {
    expect(countSavedOauthAccounts([
      reservedOauthAccount({ logged_in: true }) as OauthAccount,
      grokUuid,
    ])).toBe(1);
  });
});

describe('describeOauthUsage', () => {
  const t = (key: string) => key;

  it('keeps remaining distinct from a dead account and a failed refresh', () => {
    expect(describeOauthUsage({ ok: true, remaining: 0 }, t)).toEqual({
      text: 'settings.oauth.weeklyExhausted',
      tone: 'warn',
    });
    expect(describeOauthUsage({ ok: false, error: 'auth_revoked', remaining: null }, t)).toEqual({
      text: 'settings.oauth.weeklyRevoked',
      tone: 'error',
    });
    expect(describeOauthUsage({
      ok: false,
      remaining: 81,
      error: 'network',
      stale: true,
    }, t)).toEqual({
      text: 'settings.oauth.weeklyRemaining · settings.oauth.weeklyRefreshFailed',
      tone: 'warn',
    });
    expect(describeOauthUsage({ ok: false, error: 'network', remaining: null }, t)).toEqual({
      text: 'settings.oauth.weeklyNetwork',
      tone: 'warn',
    });
  });
});
