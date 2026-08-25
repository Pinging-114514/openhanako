import type { ReleaseDigest, UpdateDigestHistoryResult } from '../types';
import forkReleaseDigest from './fork-release-digest.json';

const EMPTY_HISTORY: UpdateDigestHistoryResult = {
  entries: [],
  source: 'none',
  complete: false,
};

const FORK_HISTORY_MAIN_SINCE = '0.447.9';
const HISTORY_LIMIT = 5;

function parseVersionParts(value: string): number[] {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .slice(0, 3)
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

export function appVersionUsesForkHistory(version: string | null | undefined): boolean {
  const current = parseVersionParts(String(version || ''));
  const min = parseVersionParts(FORK_HISTORY_MAIN_SINCE);
  while (current.length < 3) current.push(0);
  while (min.length < 3) min.push(0);
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > min[i]) return true;
    if (current[i] < min[i]) return false;
  }
  return true;
}

function forkBundledHistory(): UpdateDigestHistoryResult {
  const entries = (Array.isArray(forkReleaseDigest.entries) ? forkReleaseDigest.entries : [])
    .filter((entry): entry is ReleaseDigest => Boolean(entry && typeof entry === 'object' && entry.version))
    .slice(0, HISTORY_LIMIT);
  return {
    entries,
    source: entries.length > 0 ? 'bundled' : 'none',
    complete: entries.length >= HISTORY_LIMIT,
  };
}

function fromIpcResult(result: UpdateDigestHistoryResult | null | undefined): UpdateDigestHistoryResult {
  if (!result || !Array.isArray(result.entries)) return EMPTY_HISTORY;
  return {
    entries: result.entries.slice(0, HISTORY_LIMIT),
    source: result.source,
    complete: result.complete && result.entries.length >= HISTORY_LIMIT,
  };
}

export async function loadUpdateDigestHistory(): Promise<UpdateDigestHistoryResult> {
  const appVersion = await window.hana?.getAppVersion?.().catch(() => '');
  // 0.447.8 asar still queries liliMozi for About history. Keep that IPC off
  // until the installed shell is new enough to use the fork feed.
  if (!appVersionUsesForkHistory(appVersion)) {
    return forkBundledHistory();
  }
  const result = await window.hana?.getUpdateDigestHistory?.();
  return fromIpcResult(result);
}
