export interface AnchorCandidate {
  key: string;
  viewportOffset: number;
  aliases: readonly string[];
}

export interface AnchorSnapshot {
  scrollTop: number;
  candidates: readonly AnchorCandidate[];
}

export interface ReadingAnchorShift {
  geometryDelta: number;
  scrollTop: number;
  apply: boolean;
}

const DEFAULT_EPSILON = 1;

export function acceptRowHeight(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const rounded = Math.round(raw);
  return rounded > 0 ? rounded : null;
}

export function parseRowGap(raw: string | null | undefined): number {
  if (!raw) return 0;
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Keep the target viewport when a frame runs out of corrections. The next frame still sees the residual. */
export function deferAnchorResidual(snapshot: AnchorSnapshot, scrollTop: number): AnchorSnapshot {
  return { ...snapshot, scrollTop };
}

export function readingAnchorScrollTop(input: {
  preserve: boolean;
  previousScrollTop: number;
  previousViewportOffset: number;
  nextScrollTop: number;
  nextViewportOffset: number;
  epsilon?: number;
}): ReadingAnchorShift {
  const epsilon = input.epsilon ?? DEFAULT_EPSILON;
  const scrollDelta = input.nextScrollTop - input.previousScrollTop;
  const geometryDelta = input.nextViewportOffset - input.previousViewportOffset + scrollDelta;
  const apply = input.preserve && Number.isFinite(geometryDelta) && Math.abs(geometryDelta) >= epsilon;
  const scrollTop = apply ? input.nextScrollTop + geometryDelta : input.nextScrollTop;
  return {
    geometryDelta: Number.isFinite(geometryDelta) ? geometryDelta : 0,
    scrollTop: Number.isFinite(scrollTop) ? scrollTop : input.nextScrollTop,
    apply,
  };
}

export function selectReadingCandidates(
  rows: readonly { key: string; top: number; bottom: number; aliases?: readonly string[] }[],
  limit = 4,
): AnchorCandidate[] {
  if (rows.length === 0 || limit <= 0) return [];
  let primary = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].bottom > 1) {
      primary = i;
      break;
    }
    primary = i;
  }
  const order = [primary];
  if (primary > 0) order.push(primary - 1);
  for (let i = primary + 1; i < rows.length && order.length < limit; i += 1) order.push(i);
  return order.slice(0, limit).map((index) => {
    const row = rows[index];
    const aliases = row.aliases && row.aliases.length > 0 ? row.aliases : [row.key];
    return {
      key: row.key,
      viewportOffset: row.top,
      aliases,
    };
  });
}

export function foldAliasMap(
  folds: readonly { id: string; sourceIds: readonly string[] }[],
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const fold of folds) {
    if (!fold.id || fold.sourceIds.length === 0) continue;
    map.set(fold.id, fold.sourceIds);
  }
  return map;
}

export function buildAliasLookup(
  aliasesByKey: ReadonlyMap<string, readonly string[]> | undefined,
): Map<string, string> {
  const lookup = new Map<string, string>();
  if (!aliasesByKey) return lookup;
  for (const [key, aliases] of aliasesByKey) {
    if (!lookup.has(key)) lookup.set(key, key);
    for (const alias of aliases) {
      if (!lookup.has(alias)) lookup.set(alias, key);
    }
  }
  return lookup;
}

export function resolveCandidateElementKey(
  candidate: AnchorCandidate,
  aliasToKey: ReadonlyMap<string, string>,
  has: (key: string) => boolean,
): string | null {
  if (has(candidate.key)) return candidate.key;
  for (const alias of candidate.aliases) {
    if (alias !== candidate.key && has(alias)) return alias;
    const mapped = aliasToKey.get(alias);
    if (mapped && has(mapped)) return mapped;
  }
  const mappedSelf = aliasToKey.get(candidate.key);
  if (mappedSelf && mappedSelf !== candidate.key && has(mappedSelf)) return mappedSelf;
  return null;
}
