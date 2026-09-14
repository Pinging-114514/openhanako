import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  applyOauthAccounts,
  oauthAccountsStoreKey,
  peekOauthAccountsSlice,
  publishOauthAccountsChanged,
  requestOauthAccounts,
  resetOauthAccountsStore,
} from '../../stores/oauth-accounts-store';

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

const accounts = [{
  id: 'acc-1',
  accountId: 'acct-1',
  email: 'work@example.com',
  displayName: 'work@example.com',
  shortLabel: 'work',
  active: true,
  usage: { ok: true, remaining: 42 },
}];

describe('oauth accounts store', () => {
  beforeEach(() => {
    resetOauthAccountsStore();
  });

  it('normalizes Codex provider ids onto one store key', () => {
    expect(oauthAccountsStoreKey('openai-codex-oauth')).toBe('openai-codex');
    expect(oauthAccountsStoreKey('openai-codex')).toBe('openai-codex');
  });

  it('lets the settings window and the input pill share one account list', () => {
    applyOauthAccounts('openai-codex-oauth', accounts as any);
    expect(peekOauthAccountsSlice('openai-codex').accounts[0]?.usage).toMatchObject({ remaining: 42 });
    publishOauthAccountsChanged({
      provider: 'openai-codex',
      accounts: [{ ...accounts[0], usage: { ok: true, remaining: 9 } }],
    });
    expect(peekOauthAccountsSlice('openai-codex-oauth').accounts[0]?.usage).toMatchObject({ remaining: 9 });
  });

  it('dedupes in-flight refreshes and honors the cooldown', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ accounts }));
    const first = requestOauthAccounts('xai-oauth', fetchImpl, { refresh: true });
    const second = requestOauthAccounts('xai-oauth', fetchImpl, { refresh: true });
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockClear();
    await requestOauthAccounts('xai-oauth', fetchImpl, { refresh: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockClear();
    await requestOauthAccounts('xai-oauth', fetchImpl, { refresh: true, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
