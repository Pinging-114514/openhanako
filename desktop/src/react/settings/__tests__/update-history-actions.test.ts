/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appVersionUsesForkHistory,
  loadUpdateDigestHistory,
} from '../update-history-actions';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('appVersionUsesForkHistory', () => {
  it('treats 0.447.8 as the official-history shell', () => {
    expect(appVersionUsesForkHistory('0.447.8')).toBe(false);
  });

  it('treats 0.447.9 and later as the fork-history shell', () => {
    expect(appVersionUsesForkHistory('0.447.9')).toBe(true);
    expect(appVersionUsesForkHistory('0.451.0')).toBe(true);
  });
});

describe('loadUpdateDigestHistory', () => {
  it('does not query the 0.447.8 official history IPC', async () => {
    const getUpdateDigestHistory = vi.fn().mockResolvedValue({
      entries: [{ version: '0.449.0', summary: { zh: '官方', en: 'official' }, items: [] }],
      source: 'online',
      complete: false,
    });
    vi.stubGlobal('window', Object.assign(window, {
      hana: {
        getAppVersion: vi.fn().mockResolvedValue('0.447.8'),
        getUpdateDigestHistory,
      },
    }));

    const result = await loadUpdateDigestHistory();

    expect(getUpdateDigestHistory).not.toHaveBeenCalled();
    expect(result.source).toBe('bundled');
    expect(result.entries.map((entry) => entry.version)).toEqual([
      '0.447.9',
      '0.447.8',
      '0.447.7',
      '0.447.6',
      '0.447.5',
    ]);
  });

  it('uses IPC once the installed shell already talks to the fork', async () => {
    const getUpdateDigestHistory = vi.fn().mockResolvedValue({
      entries: [{ version: '0.447.9', summary: { zh: 'fork', en: 'fork' }, items: [] }],
      source: 'online',
      complete: false,
    });
    vi.stubGlobal('window', Object.assign(window, {
      hana: {
        getAppVersion: vi.fn().mockResolvedValue('0.447.9'),
        getUpdateDigestHistory,
      },
    }));

    const result = await loadUpdateDigestHistory();

    expect(getUpdateDigestHistory).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('online');
    expect(result.entries.map((entry) => entry.version)).toEqual(['0.447.9']);
  });
});
