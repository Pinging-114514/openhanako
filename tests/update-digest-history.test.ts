import { describe, expect, it, vi } from 'vitest';

const digest = (version: string) => ({
  schemaVersion: 1,
  tag: `v${version}`,
  version,
  previousTag: '',
  generatedAt: '2026-07-11T00:00:00.000Z',
  noUserFacingChanges: false,
  summary: { zh: `${version} 摘要`, en: `${version} summary` },
  counts: { feature: 0, fix: 0, improvement: 0, migration: 0 },
  items: [],
});

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('update digest history loader', () => {
  it('queries the fork GitHub releases API by default', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({
      fetchImpl,
      normalize: (value: ReturnType<typeof digest>) => value,
      readBundledEntries: () => [],
    });
    await load();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('https://api.github.com/repos/Pinging-114514/openhanako/releases'),
      expect.anything(),
    );
  });

  it('loads and validates the newest five published releases in website order', async () => {
    const releases = [
      ['0.500.5', false],
      ['0.500.4', false],
      ['0.500.3', true],
      ['0.500.2', false],
      ['0.500.1', false],
      ['0.500.0', false],
      ['0.499.9', false],
    ].map(([version, draft]) => ({
      tag_name: `v${version}`,
      draft,
      assets: [{ name: 'release-digest.v1.json' }],
    }));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/releases?')) return response(releases);
      const match = /download\/v([^/]+)\//.exec(url);
      return response(digest(match?.[1] || 'invalid'));
    });
    const normalize = vi.fn((value: ReturnType<typeof digest>, expectedVersion: string) => (
      value.version === expectedVersion ? value : null
    ));

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({
      fetchImpl,
      normalize,
      readBundledEntries: () => [],
    });

    const result = await load();

    expect(result.source).toBe('online');
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry: { version: string }) => entry.version)).toEqual([
      '0.500.5',
      '0.500.4',
      '0.500.2',
      '0.500.1',
      '0.500.0',
    ]);
    expect(normalize).toHaveBeenCalledTimes(6);
  });

  it('skips missing or invalid digest assets and keeps scanning newer releases first', async () => {
    const releases = [
      { tag_name: 'v0.500.5', draft: false, assets: [] },
      { tag_name: 'v0.500.4', draft: false, assets: [{ name: 'release-digest.v1.json' }] },
      { tag_name: 'v0.500.3', draft: false, assets: [{ name: 'release-digest.v1.json' }] },
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/releases?')) return response(releases);
      if (url.includes('v0.500.4')) return response(digest('0.400.0'));
      return response(digest('0.500.3'));
    });
    const normalize = (value: ReturnType<typeof digest>, expectedVersion: string) => (
      value.version === expectedVersion ? value : null
    );

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({ fetchImpl, normalize, readBundledEntries: () => [] });
    const result = await load();

    expect(result).toMatchObject({ source: 'online', complete: false });
    expect(result.entries.map((entry: { version: string }) => entry.version)).toEqual(['0.500.3']);
  });

  it('falls back explicitly to bundled entries when the website is unavailable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const bundled = [digest('0.500.1'), digest('0.500.0')];
    const log = vi.fn();

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({
      fetchImpl,
      normalize: (value: ReturnType<typeof digest>) => value,
      readBundledEntries: () => bundled,
      log,
    });
    const result = await load();

    expect(result).toEqual({ entries: bundled, source: 'bundled', complete: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('caches a successful website result to avoid repeated API requests', async () => {
    const releases = [{
      tag_name: 'v0.500.1',
      draft: false,
      assets: [{ name: 'release-digest.v1.json' }],
    }];
    const fetchImpl = vi.fn(async (url: string) => (
      url.includes('/releases?') ? response(releases) : response(digest('0.500.1'))
    ));

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({
      fetchImpl,
      normalize: (value: ReturnType<typeof digest>) => value,
      readBundledEntries: () => [],
    });

    await load();
    await load();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
