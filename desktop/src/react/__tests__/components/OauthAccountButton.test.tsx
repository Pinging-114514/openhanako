// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OauthAccountButton } from '../../components/input/OauthAccountButton';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { publishOauthAccountsChanged, resetOauthAccountsStore } from '../../stores/oauth-accounts-store';
import { createTestTranslator } from '../helpers/i18n-test-strings';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: createTestTranslator() }),
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

const accounts = [
  {
    id: 'acc-work',
    accountId: 'acct-work',
    email: 'work@example.com',
    displayName: 'work@example.com',
    shortLabel: 'work',
    active: true,
    usage: { ok: true, remaining: 42, planType: 'plus' },
  },
  {
    id: 'acc-home',
    accountId: 'acct-home',
    email: 'home@example.com',
    displayName: 'home@example.com',
    shortLabel: 'home',
    active: false,
    usage: { ok: true, remaining: 8, planType: 'plus' },
  },
];

describe('OauthAccountButton', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    resetOauthAccountsStore();
    vi.mocked(hanaFetch).mockReset();
  });

  it('shows the active account remnant and switches from the menu', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/activate')) {
        return jsonResponse({
          accounts: accounts.map(account => ({ ...account, active: account.id === 'acc-home' })),
        });
      }
      return jsonResponse({ accounts });
    });

    render(<OauthAccountButton providerId="openai-codex-oauth" />);

    const trigger = await screen.findByRole('button', { name: '账号与额度' });
    expect(trigger).toHaveTextContent('work');
    expect(trigger).toHaveTextContent('余 42%');

    fireEvent.click(trigger);
    expect(screen.getByText('home@example.com')).toBeInTheDocument();
    expect(screen.getByText(/8%/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('home@example.com'));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith(
        '/api/auth/oauth/openai-codex-oauth/accounts/activate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'acc-home' }),
        }),
      );
    });
    await waitFor(() => expect(trigger).toHaveTextContent('余 8%'));
  });

  it('refreshes usage on mount without opening the switcher', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(jsonResponse({ accounts }));
    render(<OauthAccountButton providerId="openai-codex-oauth" />);
    await screen.findByRole('button', { name: '账号与额度' });
    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/auth/oauth/openai-codex-oauth/accounts');
      expect(hanaFetch).toHaveBeenCalledWith('/api/auth/oauth/openai-codex-oauth/accounts?refresh=1');
    });
  });

  it('updates the pill when the shared account store publishes new usage', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(jsonResponse({ accounts }));
    render(<OauthAccountButton providerId="openai-codex-oauth" />);
    const trigger = await screen.findByRole('button', { name: '账号与额度' });
    expect(trigger).toHaveTextContent('余 42%');

    publishOauthAccountsChanged({
      provider: 'openai-codex',
      accounts: accounts.map(account => (
        account.id === 'acc-work'
          ? { ...account, usage: { ok: true, remaining: 11, planType: 'plus' } }
          : account
      )),
    });

    await waitFor(() => expect(trigger).toHaveTextContent('余 11%'));
  });
});
