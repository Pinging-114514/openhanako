/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ProviderSummary } from '../../settings/store';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

import { OAuthCredentials } from '../../settings/tabs/providers/OAuthCredentials';
import { resetOauthAccountsStore } from '../../stores/oauth-accounts-store';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

const summary: ProviderSummary = {
  type: 'oauth',
  auth_type: 'oauth',
  display_name: 'ChatGPT Plus/Pro',
  base_url: '',
  api: 'openai-responses',
  api_key: '',
  models: [],
  custom_models: [],
  has_credentials: false,
  logged_in: false,
  supports_oauth: true,
  can_delete: false,
};

describe('OAuthCredentials', () => {
  beforeEach(() => {
    resetOauthAccountsStore();
    mocks.hanaFetch.mockReset();
    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/accounts')) return jsonResponse({ accounts: [] });
      return jsonResponse({
        sessionId: 'oauth-session-1',
        url: 'https://auth.example/start',
      });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('requests the explicit browser login method and keeps the callback session local', async () => {
    const onRefresh = vi.fn(async () => {});
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={summary}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.login' }));

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/auth/oauth/start',
      expect.objectContaining({ method: 'POST' }),
    ));
    const startCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/auth/oauth/start');
    const [startPath, startOptions] = startCall || [];
    expect(startPath).toBe('/api/auth/oauth/start');
    expect(JSON.parse(String((startOptions as RequestInit).body))).toEqual({
      provider: 'openai-codex-oauth',
      loginMethod: 'browser',
    });

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'manual-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.submit' }));

    await waitFor(() => {
      const callbackCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/auth/oauth/callback');
      expect(callbackCall).toBeTruthy();
      expect(JSON.parse(String((callbackCall?.[1] as RequestInit).body))).toEqual({
        sessionId: 'oauth-session-1',
        code: 'manual-code',
      });
    });
  });

  it('reserves the Codex usage row before the quota request finishes', async () => {
    const pending = new Map<string, (value: Response) => void>();
    mocks.hanaFetch.mockImplementation((url: unknown) => new Promise<Response>((resolve) => {
      pending.set(String(url), resolve);
    }));
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{ ...summary, logged_in: true }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByTestId('oauth-weekly-usage')).toBeInTheDocument();
    expect(screen.queryByText(/settings.oauth.weeklyRemaining/)).not.toBeInTheDocument();

    await waitFor(() => expect(pending.has('/api/auth/oauth/openai-codex-oauth/usage')).toBe(true));
    pending.get('/api/auth/oauth/openai-codex-oauth/usage')?.(jsonResponse({
      ok: true,
      remaining: 97,
      resetAt: '2026-08-27T09:33:52.000Z',
      planType: 'pro',
      windowKind: 'week',
      windowSeconds: 604800,
    }));
    expect(await screen.findByText(/settings.oauth.weeklyRemaining/)).toBeInTheDocument();
  });

  it('shows startup-cached Codex quota immediately without waiting for a usage request', () => {
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{
          ...summary,
          logged_in: true,
          oauth_usage: {
            ok: true,
            remaining: 97,
            resetAt: '2026-08-27T09:33:52.000Z',
            planType: 'pro',
            windowKind: 'week',
            windowSeconds: 604800,
          },
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText(/settings.oauth.weeklyRemaining/)).toBeInTheDocument();
    expect(mocks.hanaFetch.mock.calls.every(([path]) => {
      const value = String(path);
      return value.includes('/accounts') || value.includes('/preferences/codex-service-tier');
    })).toBe(true);
    expect(mocks.hanaFetch.mock.calls.some(([path]) => String(path).includes('/usage'))).toBe(false);
  });

  it('shows startup-cached Grok quota immediately without waiting for a usage request', () => {
    render(
      <OAuthCredentials
        providerId="xai-oauth"
        summary={{
          ...summary,
          display_name: 'Grok',
          logged_in: true,
          oauth_usage: {
            ok: true,
            remaining: 80,
            resetAt: '2026-08-23T04:00:00.000Z',
          },
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText(/settings.oauth.weeklyRemaining/)).toBeInTheDocument();
    expect(mocks.hanaFetch.mock.calls.every(([path]) => !String(path).includes('/usage'))).toBe(true);
  });

  it('lists saved OAuth accounts with quota and identity', async () => {
    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/accounts')) {
        return jsonResponse({
          accounts: [{
            id: 'acc-1',
            accountId: 'acct-work',
            email: 'work@example.com',
            displayName: 'work@example.com',
            shortLabel: 'work',
            active: true,
            usage: { ok: true, remaining: 42, planType: 'plus' },
          }],
        });
      }
      return jsonResponse({});
    });
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{ ...summary, logged_in: true }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(await screen.findByText('work@example.com · settings.oauth.activeAccount')).toBeInTheDocument();
    expect(screen.getByText(/plus · 42%/)).toBeInTheDocument();
  });

  it('shows startup-cached OAuth accounts immediately without waiting for the accounts request', () => {
    mocks.hanaFetch.mockImplementation(() => new Promise(() => {}));
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{
          ...summary,
          logged_in: true,
          oauth_usage: { ok: true, remaining: 42, planType: 'plus' },
          oauth_accounts: [{
            id: 'acc-1',
            accountId: 'acct-work',
            email: 'work@example.com',
            displayName: 'work@example.com',
            shortLabel: 'work',
            active: true,
            usage: { ok: true, remaining: 42, planType: 'plus' },
          }],
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText('work@example.com · settings.oauth.activeAccount')).toBeInTheDocument();
    expect(screen.getByText(/plus · 42%/)).toBeInTheDocument();
  });

  it('reserves the account card when logged in before the accounts request finishes', () => {
    mocks.hanaFetch.mockImplementation(() => new Promise(() => {}));
    render(
      <OAuthCredentials
        providerId="xai-oauth"
        summary={{
          ...summary,
          display_name: 'Grok',
          logged_in: true,
          oauth_usage: { ok: true, remaining: 81 },
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    const list = screen.getByTestId('oauth-account-list');
    expect(list).toHaveTextContent('settings.oauth.activeAccount');
    expect(list).toHaveTextContent('81%');
    expect(screen.queryByText('settings.oauth.removeAccount')).not.toBeInTheDocument();
  });

  it('loads Codex OAuth remaining quota under the logged-in badge', async () => {
    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/accounts')) return jsonResponse({ accounts: [] });
      if (String(url).includes('/usage')) {
        return jsonResponse({
          ok: true,
          remaining: 97,
          resetAt: '2026-08-27T09:33:52.000Z',
          planType: 'pro',
          windowKind: 'week',
          windowSeconds: 604800,
        });
      }
      return jsonResponse({});
    });
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{ ...summary, logged_in: true }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/auth/oauth/openai-codex-oauth/usage',
    ));
    expect(await screen.findByText(/settings.oauth.weeklyRemaining/)).toBeInTheDocument();
  });

  it('says the Codex login is dead instead of weeklyUnknown', async () => {
    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/accounts')) {
        return jsonResponse({
          accounts: [{
            id: 'acc-1',
            accountId: 'acct-work',
            email: 'work@example.com',
            displayName: 'work@example.com',
            shortLabel: 'work',
            active: true,
            usage: { ok: false, error: 'auth_revoked', remaining: null },
          }],
        });
      }
      if (String(url).includes('/usage')) {
        return jsonResponse({ ok: false, error: 'auth_revoked', remaining: null });
      }
      return jsonResponse({});
    });
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{
          ...summary,
          logged_in: true,
          oauth_usage: { ok: false, error: 'auth_revoked', remaining: null },
          oauth_accounts: [{
            id: 'acc-1',
            accountId: 'acct-work',
            email: 'work@example.com',
            displayName: 'work@example.com',
            shortLabel: 'work',
            active: true,
            usage: { ok: false, error: 'auth_revoked', remaining: null },
          }],
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(await screen.findByText(/settings.oauth.accountInvalid/)).toBeInTheDocument();
    expect(screen.getAllByText(/settings.oauth.weeklyRevoked/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/settings.oauth.weeklyUnknown/)).not.toBeInTheDocument();
    expect(screen.queryByText(/settings.oauth.activeAccount/)).not.toBeInTheDocument();
  });

  it('shows a revoked inactive Grok account as invalid instead of repeating the email', async () => {
    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/accounts')) {
        return jsonResponse({
          accounts: [
            {
              id: 'acc-active',
              email: 'active@example.com',
              displayName: 'active@example.com',
              shortLabel: 'active',
              active: true,
              usage: { ok: true, remaining: 21 },
            },
            {
              id: 'acc-idle',
              email: 'idle@example.com',
              displayName: 'idle@example.com',
              shortLabel: 'idle',
              active: false,
              usage: { ok: false, error: 'auth_revoked', remaining: null },
            },
          ],
        });
      }
      return jsonResponse({});
    });
    render(
      <OAuthCredentials
        providerId="xai-oauth"
        summary={{
          ...summary,
          display_name: 'Grok',
          logged_in: true,
          oauth_accounts: [
            {
              id: 'acc-active',
              email: 'active@example.com',
              displayName: 'active@example.com',
              shortLabel: 'active',
              active: true,
              usage: { ok: true, remaining: 21 },
            },
            {
              id: 'acc-idle',
              email: 'idle@example.com',
              displayName: 'idle@example.com',
              shortLabel: 'idle',
              active: false,
              usage: { ok: false, error: 'auth_revoked', remaining: null },
            },
          ],
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText('idle@example.com · settings.oauth.accountInvalid')).toBeInTheDocument();
    expect(screen.getByText('settings.oauth.weeklyRevoked')).toBeInTheDocument();
    expect(screen.queryByText('idle@example.com · idle@example.com')).not.toBeInTheDocument();
    expect(screen.queryByTestId('oauth-weekly-usage')).not.toBeInTheDocument();
  });

  it('hides the shared weekly line when more than one account is listed', async () => {
    const accounts = [
      {
        id: 'acc-active',
        email: 'active@example.com',
        displayName: 'active@example.com',
        shortLabel: 'active',
        active: true,
        usage: { ok: true, remaining: 20 },
      },
      {
        id: 'acc-idle',
        email: 'idle@example.com',
        displayName: 'idle@example.com',
        shortLabel: 'idle',
        active: false,
        usage: { ok: true, remaining: 30 },
      },
    ];
    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/accounts')) return jsonResponse({ accounts });
      return jsonResponse({});
    });
    render(
      <OAuthCredentials
        providerId="xai-oauth"
        summary={{
          ...summary,
          display_name: 'Grok',
          logged_in: true,
          oauth_usage: { ok: true, remaining: 20, resetAt: '2026-09-10T11:55:00.000Z' },
          oauth_accounts: accounts,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.queryByTestId('oauth-weekly-usage')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('20%')).toBeInTheDocument();
      expect(screen.getByText('30%')).toBeInTheDocument();
      expect(screen.queryByTestId('oauth-weekly-usage')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/settings.oauth.weeklyReset/)).not.toBeInTheDocument();
  });

  it('keeps the last Grok percent when a refresh fails', async () => {
    render(
      <OAuthCredentials
        providerId="xai-oauth"
        summary={{
          ...summary,
          display_name: 'Grok',
          logged_in: true,
          oauth_usage: {
            ok: false,
            remaining: 81,
            error: 'network',
            stale: true,
          },
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText(/settings.oauth.weeklyRemaining/)).toBeInTheDocument();
    expect(screen.getByText(/settings.oauth.weeklyRefreshFailed/)).toBeInTheDocument();
    expect(screen.queryByText(/settings.oauth.weeklyUnknown/)).not.toBeInTheDocument();
  });

  it('hides ultrafast for a normal Codex plan and shows it only when the flag is true', async () => {
    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      const value = String(url);
      if (value.includes('/accounts')) return jsonResponse({ accounts: [] });
      if (value.includes('/codex-service-tier')) {
        return jsonResponse({
          tier: 'fast',
          preferredTier: 'ultrafast',
          ultrafastEligible: false,
          options: ['standard', 'fast', 'ultrafast'],
        });
      }
      return jsonResponse({});
    });
    const view = render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{ ...summary, logged_in: true }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    const select = await screen.findByRole('combobox', { name: 'settings.oauth.codexSpeed' });
    expect(select).not.toHaveTextContent('settings.api.codexSpeed.ultrafast');
    view.unmount();

    mocks.hanaFetch.mockImplementation(async (url: unknown) => {
      const value = String(url);
      if (value.includes('/accounts')) return jsonResponse({ accounts: [] });
      if (value.includes('/codex-service-tier')) {
        return jsonResponse({
          tier: 'fast',
          ultrafastEligible: true,
          options: ['standard', 'fast', 'ultrafast'],
        });
      }
      return jsonResponse({});
    });
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={{ ...summary, logged_in: true }}
        onRefresh={vi.fn(async () => {})}
      />,
    );
    expect(await screen.findByRole('option', { name: 'settings.api.codexSpeed.ultrafast' })).toBeInTheDocument();
  });
});
