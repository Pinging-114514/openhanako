import { describe, expect, it } from 'vitest';
import { transcriptRowTop } from '../../components/chat/transcript-window';
import {
  acceptRowHeight,
  buildAliasLookup,
  deferAnchorResidual,
  foldAliasMap,
  readingAnchorScrollTop,
  resolveCandidateElementKey,
  selectReadingCandidates,
  type AnchorCandidate,
} from '../../components/chat/transcript-scroll-anchor';

describe('transcript reading anchor', () => {
  it('rejects non-positive row heights so an empty measurement cannot become 1', () => {
    expect(acceptRowHeight(0)).toBeNull();
    expect(acceptRowHeight(-4)).toBeNull();
    expect(acceptRowHeight(0.4)).toBeNull();
    expect(acceptRowHeight(Number.NaN)).toBeNull();
    expect(acceptRowHeight(1.6)).toBe(2);
  });

  it('shifts scroll by the first real measurement above the anchor', () => {
    const keys = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    const estimated = Object.fromEntries(keys.map((key) => [key, 168]));
    const measured = { ...estimated, 'row-45': 418 };
    const before = transcriptRowTop(keys, estimated, 'row-48', 8, 168)!;
    const after = transcriptRowTop(keys, measured, 'row-48', 8, 168)!;
    expect(after - before).toBe(250);
    const shift = readingAnchorScrollTop({
      preserve: true,
      previousScrollTop: 8400,
      previousViewportOffset: before - 8400,
      nextScrollTop: 8400,
      nextViewportOffset: after - 8400,
    });
    expect(shift.apply).toBe(true);
    expect(shift.geometryDelta).toBe(250);
    expect(shift.scrollTop).toBe(8650);
    expect(after - shift.scrollTop).toBe(before - 8400);
  });

  it('preserves a prepended anchor and ignores tail growth below it', () => {
    const keys = Array.from({ length: 80 }, (_, index) => `row-${index}`);
    const heights = Object.fromEntries(keys.map((key) => [key, 168]));
    const before = transcriptRowTop(keys, heights, 'row-50', 8, 168)!;
    const prepended = ['pre-0', 'pre-1', ...keys];
    const nextHeights = { ...heights, 'pre-0': 168, 'pre-1': 168, 'row-79': 468 };
    const after = transcriptRowTop(prepended, nextHeights, 'row-50', 8, 168)!;
    expect(after - before).toBe(2 * (168 + 8));
    const shift = readingAnchorScrollTop({
      preserve: true,
      previousScrollTop: 4800,
      previousViewportOffset: before - 4800,
      nextScrollTop: 4800,
      nextViewportOffset: after - 4800,
    });
    expect(shift.scrollTop).toBe(4800 + 352);
    expect(after - shift.scrollTop).toBe(before - 4800);
  });

  it('keeps a user scroll that happened before geometry settled', () => {
    const mixed = readingAnchorScrollTop({
      preserve: true,
      previousScrollTop: 8400,
      previousViewportOffset: 48,
      nextScrollTop: 8000,
      nextViewportOffset: 698,
    });
    expect(mixed.geometryDelta).toBe(250);
    expect(mixed.scrollTop).toBe(8250);

    const userOnly = readingAnchorScrollTop({
      preserve: true,
      previousScrollTop: 8400,
      previousViewportOffset: 48,
      nextScrollTop: 8000,
      nextViewportOffset: 448,
    });
    expect(userOnly.apply).toBe(false);
    expect(userOnly.scrollTop).toBe(8000);
  });

  it('keeps the target viewport when a frame stops before the residual is gone', () => {
    const snapshot = {
      scrollTop: 8400,
      candidates: [{ key: 'row-50', viewportOffset: 48, aliases: ['row-50'] }],
    };
    const held = deferAnchorResidual(snapshot, 8500);
    expect(held.candidates[0]?.viewportOffset).toBe(48);
    expect(held.scrollTop).toBe(8500);
    const next = readingAnchorScrollTop({
      preserve: true,
      previousScrollTop: held.scrollTop,
      previousViewportOffset: held.candidates[0]!.viewportOffset,
      nextScrollTop: held.scrollTop,
      nextViewportOffset: 60,
    });
    expect(next.apply).toBe(true);
    expect(next.scrollTop).toBe(8512);
  });

  it('does not apply compensation when follow owns the scroll position', () => {
    const shift = readingAnchorScrollTop({
      preserve: false,
      previousScrollTop: 8400,
      previousViewportOffset: 48,
      nextScrollTop: 8400,
      nextViewportOffset: 298,
    });
    expect(shift.apply).toBe(false);
    expect(shift.scrollTop).toBe(8400);
    expect(shift.geometryDelta).toBe(250);
  });

  it('prefers an exact row and falls back through a fold alias', () => {
    const rows = [
      { key: 'row-a', top: -20, bottom: 40 },
      { key: 'row-b', top: 48, bottom: 120 },
      { key: 'row-c', top: 128, bottom: 200 },
    ];
    const candidates = selectReadingCandidates(rows);
    expect(candidates.map((candidate) => candidate.key)).toEqual(['row-a', 'row-b', 'row-c']);
    expect(candidates[0]?.viewportOffset).toBe(-20);
    const buried = selectReadingCandidates([
      { key: 'above', top: -180, bottom: -12 },
      { key: 'visible', top: -4, bottom: 80 },
      { key: 'next', top: 88, bottom: 140 },
    ]);
    expect(buried.map((candidate) => candidate.key)).toEqual(['visible', 'above', 'next']);

    const aliases = foldAliasMap([{ id: 'process-fold-m1-m3', sourceIds: ['m1', 'm2', 'm3'] }]);
    const lookup = buildAliasLookup(aliases);
    const folded: AnchorCandidate = { key: 'm2', viewportOffset: 80, aliases: ['m2'] };
    expect(resolveCandidateElementKey(folded, lookup, (key) => key === 'm2')).toBe('m2');
    expect(resolveCandidateElementKey(folded, lookup, (key) => key === 'process-fold-m1-m3')).toBe('process-fold-m1-m3');
    expect(resolveCandidateElementKey(folded, lookup, () => false)).toBeNull();
  });
});
