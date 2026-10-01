// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptWindow } from '../../components/chat/transcript-window';

type ResizeCallback = ResizeObserverCallback;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];

  constructor(private readonly callback: ResizeCallback) {
    MockResizeObserver.instances.push(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const model = {
  keys: [] as string[],
  heights: new Map<string, number>(),
  gap: 0,
  scrollTop: 8400,
  origin: 0,
};

function contentTop(key: string): number {
  let top = 0;
  for (const candidate of model.keys) {
    if (candidate === key) return top;
    top += (model.heights.get(candidate) ?? 168) + model.gap;
  }
  return top;
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 100,
    bottom: top + height,
    width: 100,
    height,
    toJSON() { return {}; },
  } as DOMRect;
}

function Harness({
  keys,
  preserve,
  restores,
}: {
  keys: string[];
  preserve: boolean;
  restores: number[];
}) {
  model.keys = keys;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const layout = useTranscriptWindow(keys, panelRef, [], {
    shouldPreserveAnchor: () => preserve,
    restoreScrollTop: (nextTop) => {
      restores.push(nextTop);
      const panel = panelRef.current;
      if (panel) panel.scrollTop = nextTop;
    },
  });
  const visible = layout.virtualized ? keys.slice(layout.start, layout.end + 1) : keys;
  return (
    <div
      ref={(node) => {
        panelRef.current = node;
        if (node && node.scrollTop === 0) node.scrollTop = model.scrollTop;
      }}
      data-testid="panel"
    >
      <div data-transcript-window="">
        <div style={{ height: layout.padTop }} />
        <div ref={layout.listRef} data-testid="list">
          {visible.map((key) => <div key={key} id={key} data-transcript-key={key} />)}
        </div>
        <div style={{ height: layout.padBottom }} />
      </div>
    </div>
  );
}

describe('useTranscriptWindow reading anchor', () => {
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalScrollTop: PropertyDescriptor | undefined;
  let originalClientHeight: PropertyDescriptor | undefined;
  let originalOffsetHeight: PropertyDescriptor | undefined;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    model.keys = [];
    model.heights = new Map();
    model.gap = 0;
    model.scrollTop = 8400;
    model.origin = 0;
    MockResizeObserver.instances = [];
    originalResizeObserver = window.ResizeObserver;
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    const scrollTops = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() { return scrollTops.get(this) ?? 0; },
      set(value: number) {
        scrollTops.set(this, value);
        if (this.dataset.testid === 'panel') model.scrollTop = value;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return this.dataset.testid === 'panel' ? 400 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        const key = this.dataset.transcriptKey || this.id;
        if (!key || !model.heights.has(key)) return 0;
        return model.heights.get(key) ?? 0;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function rectForRow() {
      if (this.dataset.testid === 'panel') return rect(0, 400);
      const key = this.dataset.transcriptKey || this.id;
      if (this.dataset.transcriptWindow != null) {
        return rect(model.origin - model.scrollTop, 10);
      }
      if (key && model.keys.includes(key)) {
        const height = model.heights.get(key) ?? 168;
        return rect(model.origin + contentTop(key) - model.scrollTop, height);
      }
      return originalRect.call(this);
    };
  });

  afterEach(() => {
    cleanup();
    window.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
    if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop);
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    vi.restoreAllMocks();
  });

  function renderList(keys: string[], preserve: boolean) {
    const restores: number[] = [];
    const view = render(<Harness keys={keys} preserve={preserve} restores={restores} />);
    return { ...view, restores };
  }

  it('keeps the full list and skips anchor work without a scroll parent', () => {
    const keys = Array.from({ length: 40 }, (_, index) => `m-${index}`);
    const { result } = renderHook(() => useTranscriptWindow(keys, undefined));
    expect(result.current.virtualized).toBe(false);
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(39);
    expect(result.current.padTop).toBe(0);
    expect(result.current.padBottom).toBe(0);
    expect(result.current.listRef.current).toBeNull();
  });

  it('compensates a measured row above the anchor without restoring follow', () => {
    const keys = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    for (const key of keys) model.heights.set(key, 168);
    const { restores } = renderList(keys, true);
    const before = contentTop('row-50') - model.scrollTop;
    expect(model.scrollTop).toBe(8400);
    model.heights.set('row-45', 418);
    act(() => {
      for (const observer of MockResizeObserver.instances) observer.trigger();
    });
    expect(model.scrollTop).toBe(8400 + 250);
    expect(contentTop('row-50') - model.scrollTop).toBe(before);
    expect(restores.at(-1)).toBe(8650);
  });

  it('does not move scrollTop when preserve is off', () => {
    const keys = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    for (const key of keys) model.heights.set(key, 168);
    const { restores } = renderList(keys, false);
    model.heights.set('row-45', 418);
    act(() => {
      for (const observer of MockResizeObserver.instances) observer.trigger();
    });
    expect(model.scrollTop).toBe(8400);
    expect(restores).toEqual([]);
  });

  it('applies later geometry from the scrolled position instead of the old snapshot', () => {
    const keys = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    for (const key of keys) model.heights.set(key, 168);
    const { getByTestId } = renderList(keys, true);
    const panel = getByTestId('panel');
    act(() => {
      panel.scrollTop = 8000;
      panel.dispatchEvent(new Event('scroll'));
    });
    expect(model.scrollTop).toBe(8000);
    model.heights.set('row-45', 418);
    act(() => {
      for (const observer of MockResizeObserver.instances) observer.trigger();
    });
    expect(model.scrollTop).toBe(8250);
  });

  it('holds the same row when history is prepended and the tail grows', () => {
    const keys = Array.from({ length: 80 }, (_, index) => `row-${index}`);
    for (const key of keys) model.heights.set(key, 168);
    const view = renderList(keys, true);
    const before = contentTop('row-50') - model.scrollTop;
    const prepended = ['pre-0', 'pre-1', ...keys];
    model.heights.set('pre-0', 168);
    model.heights.set('pre-1', 168);
    model.heights.set('row-79', 468);
    act(() => {
      view.rerender(<Harness keys={prepended} preserve restores={view.restores} />);
    });
    expect(model.scrollTop).toBe(8400 + (2 * 168));
    expect(contentTop('row-50') - model.scrollTop).toBe(before);
  });

  it('keeps a virtualized anchor mounted when a large page is prepended', () => {
    const keys = Array.from({ length: 90 }, (_, index) => `row-${index}`);
    for (const key of keys) model.heights.set(key, 168);
    const view = renderList(keys, true);
    const before = model.origin + contentTop('row-50') - model.scrollTop;
    expect(document.getElementById('row-50')).not.toBeNull();
    const prepended = [
      ...Array.from({ length: 40 }, (_, index) => `pre-${index}`),
      ...keys,
    ];
    for (const key of prepended) {
      if (!model.heights.has(key)) model.heights.set(key, 200);
    }
    act(() => {
      view.rerender(<Harness keys={prepended} preserve restores={view.restores} />);
    });
    const anchor = document.getElementById('row-50');
    expect(anchor).not.toBeNull();
    expect(model.origin + contentTop('row-50') - model.scrollTop).toBe(before);
    const mounted = document.querySelectorAll('[data-transcript-key]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(prepended.length);
  });

  it('selects the window from the transcript origin inside the panel', () => {
    const keys = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    for (const key of keys) model.heights.set(key, 168);
    model.origin = 2200;
    renderList(keys, true);
    expect(document.getElementById('row-0')).toBeNull();
    expect(document.getElementById('row-28')).not.toBeNull();
  });
});

describe('scroll parent ref typing stays optional for old callers', () => {
  it('accepts a missing scroll parent without reading window geometry', () => {
    const missing: RefObject<HTMLElement | null> | undefined = undefined;
    const keys = ['a', 'b'];
    const { result } = renderHook(() => useTranscriptWindow(keys, missing));
    expect(result.current.virtualized).toBe(false);
    expect(result.current.end).toBe(1);
  });
});
