// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSpeedButton } from '../../components/input/CodexSpeedButton';
import { hanaFetch } from '../../hooks/use-hana-fetch';
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
      expect(hanaFetch).toHaveBeenCalledWith('/api/preferences/codex-service-tier');
    });

    fireEvent.click(trigger);
    expect(screen.getByText('1.5 倍速度，用量更多')).toBeTruthy();
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
  });
});
