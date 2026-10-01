// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSpeedButton } from '../../components/input/CodexSpeedButton';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { resetCodexServiceTierClientForTests } from '../../hooks/use-codex-service-tier';
import { applyOauthAccounts, resetOauthAccountsStore } from '../../stores/oauth-accounts-store';
import { createTestTranslator } from '../helpers/i18n-test-strings';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: createTestTranslator() }),
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function optionForText(text: string): HTMLElement {
  const option = screen.getByText(text).closest('[role="option"]');
  if (!(option instanceof HTMLElement)) {
    throw new Error(`Option not found for ${text}`);
  }
  return option;
}

describe('CodexSpeedButton', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    resetOauthAccountsStore();
    resetCodexServiceTierClientForTests();
    vi.mocked(hanaFetch).mockReset();
  });

  it('loads the saved speed and writes the next tier', async () => {
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce(jsonResponse({ tier: 'standard' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, tier: 'fast' }));

    render(<CodexSpeedButton />);

    const trigger = await screen.findByRole('button', { name: '速度' });
    await waitFor(() => {
      expect((trigger as HTMLButtonElement).disabled).toBe(false);
      expect(hanaFetch).toHaveBeenCalledWith('/api/preferences/codex-service-tier', expect.anything());
    });

    fireEvent.click(trigger);
    expect(screen.getByText('更快，用量更多')).toBeTruthy();
    expect(screen.queryByText('超快')).toBeNull();
    fireEvent.click(optionForText('快速'));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/preferences/codex-service-tier', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ tier: 'fast' }),
      }));
    });
  });

  it('stays visible when the preference API is unavailable', async () => {
    vi.mocked(hanaFetch).mockRejectedValueOnce(new Error('not found'));

    render(<CodexSpeedButton />);

    expect(await screen.findByRole('button', { name: '速度' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '速度' }));
    expect(screen.queryByText('超快')).toBeNull();
    expect(vi.mocked(hanaFetch).mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('ignores a full option list when the account flag is missing or false', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(jsonResponse({
      tier: 'fast',
      options: ['standard', 'fast', 'ultrafast'],
    }));

    render(<CodexSpeedButton modelId="gpt-6-astra" />);
    const trigger = await screen.findByRole('button', { name: '速度' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    expect(screen.queryByText('超快')).toBeNull();
    expect(screen.getByText('快速')).toBeTruthy();
  });

  it('shows ultrafast only for Astra when the account is eligible', async () => {
    vi.mocked(hanaFetch).mockResolvedValue(jsonResponse({
      tier: 'ultrafast',
      preferredTier: 'ultrafast',
      ultrafastEligible: true,
      options: ['standard', 'fast', 'ultrafast'],
    }));

    const { unmount } = render(<CodexSpeedButton modelId="openai/GPT-6-Astra-2026-09-30" />);
    const astra = await screen.findByRole('button', { name: '速度' });
    await waitFor(() => expect((astra as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(astra);
    expect(screen.getByText('超快')).toBeTruthy();
    unmount();

    render(<CodexSpeedButton modelId="gpt-6.1-sol" />);
    const sol = await screen.findByRole('button', { name: '速度' });
    await waitFor(() => expect((sol as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sol);
    expect(screen.queryByText('超快')).toBeNull();
    expect(screen.getByText('快速')).toBeTruthy();
  });

  it('writes fast once when an old backend still has ultrafast selected', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, tier: 'fast', options: ['standard', 'fast', 'ultrafast'] });
      }
      return jsonResponse({ tier: 'ultrafast', options: ['standard', 'fast', 'ultrafast'] });
    });

    render(<CodexSpeedButton modelId="gpt-6-astra" />);
    await waitFor(() => {
      const puts = vi.mocked(hanaFetch).mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(JSON.parse(String((puts[0][1] as RequestInit).body))).toEqual({ tier: 'fast' });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '速度' }).getAttribute('title')).toContain('快速');
    });
    fireEvent.click(screen.getByRole('button', { name: '速度' }));
    expect(screen.queryByText('超快')).toBeNull();
  });

  it('drops a stale eligible response after the account changes', async () => {
    const pending: Array<(value: Response) => void> = [];
    vi.mocked(hanaFetch).mockImplementation(() => new Promise<Response>((resolve) => {
      pending.push(resolve);
    }));

    render(<CodexSpeedButton modelId="gpt-6-astra" />);
    await waitFor(() => expect(pending.length).toBe(1));
    applyOauthAccounts('openai-codex', [{
      id: 'acc-pro',
      accountId: 'acc-pro',
      email: 'pro@example.com',
      displayName: 'pro@example.com',
      shortLabel: 'pro',
      active: true,
      usage: { ok: true, remaining: 40, planType: 'pro' },
    }]);
    await waitFor(() => expect(pending.length).toBe(2));
    pending[0](jsonResponse({
      tier: 'ultrafast',
      ultrafastEligible: true,
      options: ['standard', 'fast', 'ultrafast'],
    }));
    pending[1](jsonResponse({
      tier: 'fast',
      ultrafastEligible: false,
      options: ['standard', 'fast'],
    }));

    const trigger = await screen.findByRole('button', { name: '速度' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    expect(screen.queryByText('超快')).toBeNull();
    expect(screen.getByText('快速')).toBeTruthy();
    expect(vi.mocked(hanaFetch).mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('sends the composer model and drops ultrafast when the backend rejects it', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            tier: 'fast',
            ultrafastEligible: false,
            options: ['standard', 'fast'],
          }),
        } as Response;
      }
      return jsonResponse({
        tier: 'fast',
        ultrafastEligible: true,
        options: ['standard', 'fast', 'ultrafast'],
      });
    });

    render(<CodexSpeedButton modelId="gpt-6-astra" />);
    const trigger = await screen.findByRole('button', { name: '速度' });
    await waitFor(() => {
      expect((trigger as HTMLButtonElement).disabled).toBe(false);
      expect(hanaFetch).toHaveBeenCalledWith(
        '/api/preferences/codex-service-tier?modelId=gpt-6-astra',
        expect.anything(),
      );
    });
    fireEvent.click(trigger);
    fireEvent.click(optionForText('超快'));
    await waitFor(() => {
      const puts = vi.mocked(hanaFetch).mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(JSON.parse(String((puts[0][1] as RequestInit).body))).toEqual({
        tier: 'ultrafast',
        modelId: 'gpt-6-astra',
      });
    });
    await waitFor(() => expect((screen.getByRole('button', { name: '速度' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '速度' }));
    expect(screen.queryByText('超快')).toBeNull();
    expect(screen.getByText('快速')).toBeTruthy();
  });

  it('releases a stuck save when a newer load takes the request', async () => {
    const gets: Array<(value: Response) => void> = [];
    const pendingPut: { resolve?: (value: Response) => void } = {};
    vi.mocked(hanaFetch).mockImplementation((_url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      if (init?.method === 'PUT') pendingPut.resolve = resolve;
      else gets.push(resolve);
    }));

    render(<CodexSpeedButton modelId="gpt-6-astra" />);
    await waitFor(() => expect(gets.length).toBe(1));
    gets[0](jsonResponse({
      tier: 'fast',
      ultrafastEligible: true,
      options: ['standard', 'fast', 'ultrafast'],
    }));
    const trigger = await screen.findByRole('button', { name: '速度' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(optionForText('超快'));
    await waitFor(() => expect(pendingPut.resolve).toBeTruthy());
    expect((screen.getByRole('button', { name: '速度' }) as HTMLButtonElement).disabled).toBe(true);

    applyOauthAccounts('openai-codex', [{
      id: 'acc-pro',
      accountId: 'acc-pro',
      email: 'pro@example.com',
      displayName: 'pro@example.com',
      shortLabel: 'pro',
      active: true,
      usage: { ok: true, remaining: 40, planType: 'pro' },
    }]);
    await waitFor(() => expect(gets.length).toBe(2));
    gets[1](jsonResponse({
      tier: 'fast',
      ultrafastEligible: false,
      options: ['standard', 'fast'],
    }));
    await waitFor(() => expect((screen.getByRole('button', { name: '速度' }) as HTMLButtonElement).disabled).toBe(false));

    pendingPut.resolve?.(jsonResponse({
      ok: true,
      tier: 'ultrafast',
      ultrafastEligible: true,
      options: ['standard', 'fast', 'ultrafast'],
    }));
    await waitFor(() => expect((screen.getByRole('button', { name: '速度' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '速度' }));
    expect(screen.queryByText('超快')).toBeNull();
  });
});
