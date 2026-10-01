import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  acceptRowHeight,
  buildAliasLookup,
  parseRowGap,
  readingAnchorScrollTop,
  resolveCandidateElementKey,
  deferAnchorResidual,
  selectReadingCandidates,
  type AnchorSnapshot,
} from './transcript-scroll-anchor';

export const TRANSCRIPT_WINDOW_ESTIMATE_PX = 168;
export const TRANSCRIPT_WINDOW_OVERSCAN_PX = 1400;
export const TRANSCRIPT_WINDOW_MIN_COUNT = 36;

const EMPTY_KEYS: readonly string[] = [];
const MAX_ANCHOR_APPLIES_PER_FRAME = 3;

export interface TranscriptWindowInput {
  keys: readonly string[];
  heightByKey: ReadonlyMap<string, number> | Record<string, number>;
  scrollTop: number;
  viewportHeight: number;
  pinKeys?: Iterable<string>;
  estimatePx?: number;
  overscanPx?: number;
  minCount?: number;
  /** Row gap of the list. Pads sit outside that list, so hidden rows keep the gap in the offset. */
  gapPx?: number;
}

export interface TranscriptWindowLayout {
  virtualized: boolean;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

export interface TranscriptScrollAnchorOptions {
  active?: boolean;
  shouldPreserveAnchor?: () => boolean;
  restoreScrollTop?: (nextTop: number) => void;
  /** Current render key to extra ids that should still find the row after a process fold. */
  aliasesByKey?: ReadonlyMap<string, readonly string[]>;
}

function readHeight(
  heightByKey: TranscriptWindowInput['heightByKey'],
  key: string,
  estimatePx: number,
): number {
  const raw = heightByKey instanceof Map ? heightByKey.get(key) : heightByKey[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : estimatePx;
}

function normalizeGap(gapPx: number | undefined): number {
  return typeof gapPx === 'number' && Number.isFinite(gapPx) && gapPx > 0 ? gapPx : 0;
}

export function buildTranscriptOffsets(
  keys: readonly string[],
  heightByKey: TranscriptWindowInput['heightByKey'],
  gapPx = 0,
  estimatePx = TRANSCRIPT_WINDOW_ESTIMATE_PX,
): number[] {
  const gap = normalizeGap(gapPx);
  const offsets = new Array<number>(keys.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < keys.length; i += 1) {
    offsets[i + 1] = offsets[i] + readHeight(heightByKey, keys[i], estimatePx) + (i < keys.length - 1 ? gap : 0);
  }
  return offsets;
}

export function transcriptRowTop(
  keys: readonly string[],
  heightByKey: TranscriptWindowInput['heightByKey'],
  key: string,
  gapPx = 0,
  estimatePx = TRANSCRIPT_WINDOW_ESTIMATE_PX,
): number | null {
  const index = keys.indexOf(key);
  if (index < 0) return null;
  return buildTranscriptOffsets(keys, heightByKey, gapPx, estimatePx)[index];
}

/** Content Y of a rendered row: pad plus gaps between rows that are still mounted. */
export function renderedRowContentTop(
  layout: TranscriptWindowLayout,
  index: number,
  heights: readonly number[],
  gapPx: number,
): number | null {
  if (index < layout.start || index > layout.end) return null;
  const gap = normalizeGap(gapPx);
  let top = layout.padTop;
  for (let i = layout.start; i < index; i += 1) {
    top += heights[i] + gap;
  }
  return top;
}

export function resolveTranscriptWindow(input: TranscriptWindowInput): TranscriptWindowLayout {
  const keys = input.keys;
  const count = keys.length;
  const minCount = input.minCount ?? TRANSCRIPT_WINDOW_MIN_COUNT;
  if (count === 0) {
    return { virtualized: false, start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  if (count < minCount) {
    return { virtualized: false, start: 0, end: count - 1, padTop: 0, padBottom: 0 };
  }

  const estimatePx = input.estimatePx ?? TRANSCRIPT_WINDOW_ESTIMATE_PX;
  const offsets = buildTranscriptOffsets(keys, input.heightByKey, input.gapPx, estimatePx);
  const total = offsets[count];
  const scrollTop = Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0);
  const viewportHeight = Math.max(1, Number.isFinite(input.viewportHeight) ? input.viewportHeight : 1);
  const overscanPx = input.overscanPx ?? TRANSCRIPT_WINDOW_OVERSCAN_PX;
  const viewStart = Math.max(0, scrollTop - overscanPx);
  const viewEnd = scrollTop + viewportHeight + overscanPx;

  let start = 0;
  while (start < count - 1 && offsets[start + 1] < viewStart) start += 1;
  let end = count - 1;
  while (end > start && offsets[end] > viewEnd) end -= 1;

  if (input.pinKeys) {
    const indexByKey = new Map(keys.map((key, index) => [key, index]));
    for (const pin of input.pinKeys) {
      const index = indexByKey.get(pin);
      if (index == null) continue;
      if (index < start) start = index;
      if (index > end) end = index;
    }
  }

  // The list has gaps between mounted rows, not after the last one, and the
  // window wrapper has no gap. The boundary gap belongs to padBottom.
  const visibleBottom = offsets[end] + readHeight(input.heightByKey, keys[end], estimatePx);
  return {
    virtualized: true,
    start,
    end,
    padTop: offsets[start],
    padBottom: Math.max(0, total - visibleBottom),
  };
}

function fullLayout(count: number): TranscriptWindowLayout {
  return {
    virtualized: false,
    start: 0,
    end: Math.max(0, count - 1),
    padTop: 0,
    padBottom: 0,
  };
}

function layoutsEqual(a: TranscriptWindowLayout, b: TranscriptWindowLayout): boolean {
  return a.virtualized === b.virtualized
    && a.start === b.start
    && a.end === b.end
    && a.padTop === b.padTop
    && a.padBottom === b.padBottom;
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readContentOrigin(panel: HTMLElement, list: HTMLElement): number {
  const host = list.parentElement;
  if (!host) return 0;
  const origin = host.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
  return Number.isFinite(origin) ? origin : 0;
}

function holdAnchorTarget(
  snapshotRef: { current: AnchorSnapshot | null },
  scrollTop: number,
) {
  const snapshot = snapshotRef.current;
  if (!snapshot) return;
  snapshotRef.current = deferAnchorResidual(snapshot, scrollTop);
}

const ANCHOR_HOLD_SPAN = 240;

function holdableAnchorKey(
  snapshot: AnchorSnapshot | null,
  keys: readonly string[],
): string | undefined {
  if (!snapshot) return undefined;
  const keySet = new Set(keys);
  for (const candidate of snapshot.candidates) {
    if (candidate.viewportOffset < -2000 || candidate.viewportOffset > 2000) continue;
    if (keySet.has(candidate.key)) return candidate.key;
    for (const alias of candidate.aliases) {
      if (keySet.has(alias)) return alias;
    }
  }
  return undefined;
}

function layoutCoveringAnchor(input: {
  layout: TranscriptWindowLayout;
  keys: readonly string[];
  anchorKey: string | undefined;
  panel: HTMLElement | null;
  heightByKey: ReadonlyMap<string, number>;
  pinKeys: readonly string[];
  gapPx: number;
  contentOrigin: number;
}): TranscriptWindowLayout {
  const { layout, keys, anchorKey, panel } = input;
  if (!layout.virtualized || !anchorKey || !panel) return layout;
  const index = keys.indexOf(anchorKey);
  if (index < 0 || (index >= layout.start && index <= layout.end)) return layout;
  const distance = index < layout.start ? layout.start - index : index - layout.end;
  if (distance > ANCHOR_HOLD_SPAN) return layout;
  return resolveTranscriptWindow({
    keys,
    heightByKey: input.heightByKey,
    scrollTop: panel.scrollTop - input.contentOrigin,
    viewportHeight: panel.clientHeight || 800,
    pinKeys: [anchorKey, ...input.pinKeys],
    gapPx: input.gapPx,
  });
}

function findDirectRow(root: HTMLElement, key: string): HTMLElement | null {
  const children = root.children;
  for (let i = 0; i < children.length; i += 1) {
    const el = children[i] as HTMLElement;
    if (el.dataset?.transcriptKey === key || el.id === key) return el;
  }
  return null;
}

export function useTranscriptWindow(
  keys: readonly string[],
  scrollRef: RefObject<HTMLElement | null> | undefined,
  pinKeys: readonly string[] = EMPTY_KEYS,
  options?: TranscriptScrollAnchorOptions,
): TranscriptWindowLayout & { listRef: RefObject<HTMLDivElement | null> } {
  const heightByKeyRef = useRef(new Map<string, number>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef(0);
  const resetApplyFrameRef = useRef(0);
  const applyCountRef = useRef(0);
  const applyingRef = useRef(false);
  const wasActiveRef = useRef(true);
  const contentOriginRef = useRef(0);
  const resumeFrameRef = useRef(0);
  const resumeBudgetRef = useRef(4);
  const gapRef = useRef(0);
  const snapshotRef = useRef<AnchorSnapshot | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const keysRef = useRef(keys);
  const keyRevRef = useRef(0);
  if (!sameStringList(keysRef.current, keys)) {
    keysRef.current = keys;
    keyRevRef.current += 1;
  }
  const keyRev = keyRevRef.current;

  const pinRef = useRef(pinKeys);
  const pinRevRef = useRef(0);
  if (!sameStringList(pinRef.current, pinKeys)) {
    pinRef.current = pinKeys;
    pinRevRef.current += 1;
  }
  const pinRev = pinRevRef.current;

  const [layout, setLayout] = useState<TranscriptWindowLayout>(() => (
    scrollRef
      ? resolveTranscriptWindow({
          keys,
          heightByKey: heightByKeyRef.current,
          scrollTop: 0,
          viewportHeight: 800,
          pinKeys,
        })
      : fullLayout(keys.length)
  ));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const recompute = useCallback(() => {
    if (!scrollRef) {
      const full = fullLayout(keysRef.current.length);
      setLayout((prev) => (layoutsEqual(prev, full) ? prev : full));
      return;
    }
    const panel = scrollRef.current;
    const origin = panel && listRef.current ? readContentOrigin(panel, listRef.current) : contentOriginRef.current;
    contentOriginRef.current = origin;
    const next = resolveTranscriptWindow({
      keys: keysRef.current,
      heightByKey: heightByKeyRef.current,
      scrollTop: panel ? panel.scrollTop - origin : 0,
      viewportHeight: panel ? panel.clientHeight : 800,
      pinKeys: pinRef.current,
      gapPx: gapRef.current,
    });
    setLayout((prev) => (layoutsEqual(prev, next) ? prev : next));
  }, [keyRev, pinRev, scrollRef]);

  const scheduleRecompute = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      recompute();
    });
  }, [recompute]);

  const readGap = useCallback((root: HTMLElement) => {
    const style = getComputedStyle(root);
    const next = parseRowGap(style.rowGap) || parseRowGap(style.gap);
    if (Math.abs(next - gapRef.current) < 0.5) return false;
    gapRef.current = next;
    return true;
  }, []);

  const measureRows = useCallback((root: HTMLElement) => {
    const current = layoutRef.current;
    const source = keysRef.current;
    const visible = current.virtualized
      ? source.slice(current.start, current.end + 1)
      : source;
    const visibleSet = new Set(visible);
    const map = heightByKeyRef.current;
    let changed = false;
    const children = root.children;
    for (let i = 0; i < children.length; i += 1) {
      const el = children[i] as HTMLElement;
      const marked = el.dataset?.transcriptKey || '';
      const key = marked || (el.id && visibleSet.has(el.id) ? el.id : '');
      if (!key) continue;
      const height = acceptRowHeight(el.offsetHeight);
      if (height == null) continue;
      const prev = map.get(key);
      if (prev != null && Math.abs(prev - height) < 2) continue;
      map.set(key, height);
      if (prev == null && Math.abs(height - TRANSCRIPT_WINDOW_ESTIMATE_PX) < 2) continue;
      changed = true;
    }
    return changed;
  }, []);

  const captureSnapshot = useCallback((panel: HTMLElement): AnchorSnapshot | null => {
    const root = listRef.current;
    if (!root || panel.clientHeight <= 0) return null;
    const panelRect = panel.getBoundingClientRect();
    const aliasesByKey = optionsRef.current?.aliasesByKey;
    const rows: { key: string; top: number; bottom: number; aliases: string[] }[] = [];
    const children = root.children;
    for (let i = 0; i < children.length; i += 1) {
      const el = children[i] as HTMLElement;
      const key = el.dataset?.transcriptKey || el.id;
      if (!key) continue;
      const rect = el.getBoundingClientRect();
      const extra = aliasesByKey?.get(key) ?? EMPTY_KEYS;
      const aliases = [key];
      for (const alias of extra) {
        if (alias !== key) aliases.push(alias);
      }
      rows.push({
        key,
        top: rect.top - panelRect.top,
        bottom: rect.bottom - panelRect.top,
        aliases,
      });
    }
    rows.sort((a, b) => a.top - b.top);
    const candidates = selectReadingCandidates(rows);
    if (candidates.length === 0) return null;
    return { scrollTop: panel.scrollTop, candidates };
  }, []);

  const writeScroll = useCallback((panel: HTMLElement, nextTop: number) => {
    if (Math.abs(panel.scrollTop - nextTop) < 1) return;
    applyingRef.current = true;
    try {
      const restore = optionsRef.current?.restoreScrollTop;
      if (restore) restore(nextTop);
      else panel.scrollTop = nextTop;
    } finally {
      applyingRef.current = false;
    }
  }, []);

  const alignRef = useRef<() => boolean>(() => false);
  const scheduleAnchorResume = useCallback(() => {
    if (resumeFrameRef.current || resumeBudgetRef.current <= 0) return;
    resumeBudgetRef.current -= 1;
    resumeFrameRef.current = window.requestAnimationFrame(() => {
      resumeFrameRef.current = 0;
      applyCountRef.current = 0;
      if (alignRef.current()) scheduleRecompute();
    });
  }, [scheduleRecompute]);

  const alignReading = useCallback((): boolean => {
    const panel = scrollRef?.current;
    if (!panel || panel.clientHeight <= 0) return false;
    const anchorOptions = optionsRef.current;
    const active = anchorOptions?.active !== false;
    if (!active) {
      wasActiveRef.current = false;
      return false;
    }
    if (!wasActiveRef.current) {
      wasActiveRef.current = true;
      const shot = captureSnapshot(panel);
      if (shot) snapshotRef.current = shot;
      return false;
    }
    const preserve = anchorOptions?.shouldPreserveAnchor
      ? anchorOptions.shouldPreserveAnchor()
      : Boolean(scrollRef);
    if (!preserve) {
      const shot = captureSnapshot(panel);
      if (shot) snapshotRef.current = shot;
      return false;
    }
    if (applyCountRef.current >= MAX_ANCHOR_APPLIES_PER_FRAME) {
      holdAnchorTarget(snapshotRef, panel.scrollTop);
      scheduleAnchorResume();
      return false;
    }

    const snapshot = snapshotRef.current;
    if (!snapshot || snapshot.candidates.length === 0) {
      const shot = captureSnapshot(panel);
      if (shot) snapshotRef.current = shot;
      return false;
    }

    const root = listRef.current;
    const lookup = buildAliasLookup(anchorOptions?.aliasesByKey);
    const hasRow = (key: string) => (root ? findDirectRow(root, key) != null : false);
    let previousViewportOffset: number | null = null;
    let nextViewportOffset: number | null = null;
    let locatedInDom = false;

    if (root) {
      for (const candidate of snapshot.candidates) {
        const el = findDirectRow(root, candidate.key);
        if (!el) continue;
        previousViewportOffset = candidate.viewportOffset;
        nextViewportOffset = el.getBoundingClientRect().top - panel.getBoundingClientRect().top;
        locatedInDom = true;
        break;
      }
      if (nextViewportOffset == null) {
        for (const candidate of snapshot.candidates) {
          const key = resolveCandidateElementKey(candidate, lookup, hasRow);
          if (!key) continue;
          const el = findDirectRow(root, key);
          if (!el) continue;
          previousViewportOffset = candidate.viewportOffset;
          nextViewportOffset = el.getBoundingClientRect().top - panel.getBoundingClientRect().top;
          locatedInDom = true;
          break;
        }
      }
    }

    if (nextViewportOffset == null || previousViewportOffset == null) {
      const keySet = new Set(keysRef.current);
      for (const candidate of snapshot.candidates) {
        const key = resolveCandidateElementKey(candidate, lookup, (itemKey) => keySet.has(itemKey));
        if (!key || !heightByKeyRef.current.has(key)) continue;
        const top = transcriptRowTop(
          keysRef.current,
          heightByKeyRef.current,
          key,
          gapRef.current,
        );
        if (top == null) continue;
        previousViewportOffset = candidate.viewportOffset;
        nextViewportOffset = contentOriginRef.current + top - panel.scrollTop;
        break;
      }
    }

    if (nextViewportOffset == null || previousViewportOffset == null) {
      const shot = captureSnapshot(panel);
      if (shot) snapshotRef.current = shot;
      return false;
    }

    const decision = readingAnchorScrollTop({
      preserve: true,
      previousScrollTop: snapshot.scrollTop,
      previousViewportOffset,
      nextScrollTop: panel.scrollTop,
      nextViewportOffset,
    });
    if (!decision.apply) {
      resumeBudgetRef.current = 4;
      if (!locatedInDom || Math.abs(panel.scrollTop - snapshot.scrollTop) >= 1) {
        const shot = captureSnapshot(panel);
        if (shot) snapshotRef.current = shot;
      }
      return false;
    }

    const nextTop = Math.max(0, decision.scrollTop);
    const before = panel.scrollTop;
    applyCountRef.current += 1;
    if (!resetApplyFrameRef.current) {
      resetApplyFrameRef.current = window.requestAnimationFrame(() => {
        resetApplyFrameRef.current = 0;
        applyCountRef.current = 0;
      });
    }
    writeScroll(panel, nextTop);
    if (Math.abs(panel.scrollTop - before) < 1) {
      holdAnchorTarget(snapshotRef, panel.scrollTop);
      return false;
    }
    const shot = captureSnapshot(panel);
    if (shot) snapshotRef.current = shot;
    else snapshotRef.current = { ...snapshot, scrollTop: panel.scrollTop };
    return true;
  }, [captureSnapshot, scheduleAnchorResume, scrollRef, writeScroll]);
  alignRef.current = alignReading;

  if (scrollRef?.current && listRef.current) {
    contentOriginRef.current = readContentOrigin(scrollRef.current, listRef.current);
  }
  const outputLayout = layoutCoveringAnchor({
    layout,
    keys: keysRef.current,
    anchorKey: holdableAnchorKey(snapshotRef.current, keysRef.current),
    panel: scrollRef?.current ?? null,
    heightByKey: heightByKeyRef.current,
    pinKeys: pinRef.current,
    gapPx: gapRef.current,
    contentOrigin: contentOriginRef.current,
  });
  layoutRef.current = outputLayout;

  useLayoutEffect(() => {
    const root = listRef.current;
    if (root) {
      const gapChanged = readGap(root);
      const heightsChanged = measureRows(root);
      const moved = alignReading();
      recompute();
      if (gapChanged || heightsChanged || moved) scheduleRecompute();
    } else {
      recompute();
    }
  }, [
    alignReading,
    measureRows,
    outputLayout.end,
    outputLayout.padBottom,
    outputLayout.padTop,
    outputLayout.start,
    outputLayout.virtualized,
    readGap,
    recompute,
    scheduleRecompute,
  ]);

  useEffect(() => {
    const panel = scrollRef?.current;
    if (!panel) return undefined;
    const onScroll = () => {
      if (applyingRef.current) return;
      alignReading();
      scheduleRecompute();
    };
    panel.addEventListener('scroll', onScroll, { passive: true });
    return () => panel.removeEventListener('scroll', onScroll);
  }, [alignReading, scheduleRecompute, scrollRef]);

  const visibleKeySignature = outputLayout.virtualized
    ? `${outputLayout.start}:${outputLayout.end}:${keyRev}`
    : `full:${keyRev}`;

  useEffect(() => {
    const root = listRef.current;
    const panel = scrollRef?.current;
    if (!root || !panel) return undefined;
    const sync = () => {
      const gapChanged = readGap(root);
      const heightsChanged = measureRows(root);
      const moved = alignReading();
      if (gapChanged || heightsChanged || moved) scheduleRecompute();
    };
    sync();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => sync());
    for (const child of Array.from(root.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [alignReading, measureRows, readGap, scheduleRecompute, scrollRef, visibleKeySignature]);

  useEffect(() => () => {
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    if (resetApplyFrameRef.current) window.cancelAnimationFrame(resetApplyFrameRef.current);
    if (resumeFrameRef.current) window.cancelAnimationFrame(resumeFrameRef.current);
  }, []);

  return { ...outputLayout, listRef };
}
