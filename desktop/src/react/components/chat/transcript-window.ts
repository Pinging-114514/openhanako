import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const TRANSCRIPT_WINDOW_ESTIMATE_PX = 168;
export const TRANSCRIPT_WINDOW_OVERSCAN_PX = 1400;
export const TRANSCRIPT_WINDOW_MIN_COUNT = 36;

export interface TranscriptWindowInput {
  keys: readonly string[];
  heightByKey: ReadonlyMap<string, number> | Record<string, number>;
  scrollTop: number;
  viewportHeight: number;
  pinKeys?: Iterable<string>;
  estimatePx?: number;
  overscanPx?: number;
  minCount?: number;
}

export interface TranscriptWindowLayout {
  virtualized: boolean;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

function readHeight(
  heightByKey: TranscriptWindowInput['heightByKey'],
  key: string,
  estimatePx: number,
): number {
  const raw = heightByKey instanceof Map ? heightByKey.get(key) : heightByKey[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : estimatePx;
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
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i += 1) {
    offsets[i + 1] = offsets[i] + readHeight(input.heightByKey, keys[i], estimatePx);
  }
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

  return {
    virtualized: true,
    start,
    end,
    padTop: offsets[start],
    padBottom: Math.max(0, total - offsets[end + 1]),
  };
}

function layoutsEqual(a: TranscriptWindowLayout, b: TranscriptWindowLayout): boolean {
  return a.virtualized === b.virtualized
    && a.start === b.start
    && a.end === b.end
    && a.padTop === b.padTop
    && a.padBottom === b.padBottom;
}

function roundHeight(value: number): number {
  return Math.max(1, Math.round(value));
}

export function useTranscriptWindow(
  keys: readonly string[],
  scrollRef: RefObject<HTMLElement | null> | undefined,
  pinKeys: readonly string[] = [],
): TranscriptWindowLayout & { listRef: RefObject<HTMLDivElement | null> } {
  const heightByKeyRef = useRef(new Map<string, number>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef(0);
  const [layout, setLayout] = useState<TranscriptWindowLayout>(() => resolveTranscriptWindow({
    keys,
    heightByKey: heightByKeyRef.current,
    scrollTop: 0,
    viewportHeight: 800,
    pinKeys,
  }));

  const recompute = useCallback(() => {
    if (!scrollRef) {
      const full: TranscriptWindowLayout = {
        virtualized: false,
        start: 0,
        end: Math.max(0, keys.length - 1),
        padTop: 0,
        padBottom: 0,
      };
      setLayout((prev) => (layoutsEqual(prev, full) ? prev : full));
      return;
    }
    const panel = scrollRef.current;
    const next = resolveTranscriptWindow({
      keys,
      heightByKey: heightByKeyRef.current,
      scrollTop: panel ? panel.scrollTop : 0,
      viewportHeight: panel ? panel.clientHeight : 800,
      pinKeys,
    });
    setLayout((prev) => (layoutsEqual(prev, next) ? prev : next));
  }, [keys, pinKeys, scrollRef]);

  const scheduleRecompute = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      recompute();
    });
  }, [recompute]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const panel = scrollRef?.current;
    if (!panel) return undefined;
    const onScroll = () => scheduleRecompute();
    panel.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      panel.removeEventListener('scroll', onScroll);
    };
  }, [keys.length, scheduleRecompute, scrollRef]);

  const visibleKeySignature = layout.virtualized
    ? `${layout.start}:${layout.end}`
    : 'full';

  useEffect(() => {
    const root = listRef.current;
    if (!root || !layout.virtualized) return undefined;
    const visibleKeys = keys.slice(layout.start, layout.end + 1);

    const readVisibleHeights = (): boolean => {
      const children = root.children;
      const map = heightByKeyRef.current;
      let changed = false;
      const count = Math.min(children.length, visibleKeys.length);
      for (let i = 0; i < count; i += 1) {
        const key = visibleKeys[i];
        const height = roundHeight((children[i] as HTMLElement).offsetHeight);
        if (!(height > 0)) continue;
        const prev = map.get(key);
        if (prev != null && Math.abs(prev - height) < 2) continue;
        map.set(key, height);
        changed = true;
      }
      return changed;
    };

    if (readVisibleHeights()) scheduleRecompute();
    if (typeof ResizeObserver !== 'function') return undefined;

    const observer = new ResizeObserver(() => {
      if (readVisibleHeights()) scheduleRecompute();
    });
    for (const child of Array.from(root.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [keys, layout.end, layout.start, layout.virtualized, scheduleRecompute, visibleKeySignature]);

  useEffect(() => () => {
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
  }, []);

  return { ...layout, listRef };
}
