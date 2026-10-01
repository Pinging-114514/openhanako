import { describe, expect, it } from 'vitest';
import {
  buildTranscriptOffsets,
  renderedRowContentTop,
  resolveTranscriptWindow,
} from '../../components/chat/transcript-window';

describe('resolveTranscriptWindow', () => {
  it('renders the full list below the virtualization threshold', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `m-${i}`);
    expect(resolveTranscriptWindow({
      keys,
      heightByKey: {},
      scrollTop: 0,
      viewportHeight: 600,
    })).toEqual({
      virtualized: false,
      start: 0,
      end: 11,
      padTop: 0,
      padBottom: 0,
    });
  });

  it('keeps a contiguous window around the viewport and pads the rest', () => {
    const keys = Array.from({ length: 80 }, (_, i) => `m-${i}`);
    const heightByKey = Object.fromEntries(keys.map((key) => [key, 100]));
    const layout = resolveTranscriptWindow({
      keys,
      heightByKey,
      scrollTop: 3000,
      viewportHeight: 400,
      estimatePx: 100,
      overscanPx: 200,
      minCount: 20,
    });
    expect(layout.virtualized).toBe(true);
    expect(layout.start).toBeGreaterThan(0);
    expect(layout.end).toBeLessThan(79);
    expect(layout.end - layout.start).toBeLessThan(20);
    expect(layout.padTop).toBe(layout.start * 100);
    expect(layout.padBottom).toBe((79 - layout.end) * 100);
  });

  it('expands the contiguous window to include pinned keys', () => {
    const keys = Array.from({ length: 80 }, (_, i) => `m-${i}`);
    const layout = resolveTranscriptWindow({
      keys,
      heightByKey: {},
      scrollTop: 0,
      viewportHeight: 400,
      pinKeys: ['m-70'],
      estimatePx: 100,
      overscanPx: 0,
      minCount: 20,
    });
    expect(layout.start).toBe(0);
    expect(layout.end).toBe(70);
    expect(layout.padBottom).toBe(900);
  });

  it('keeps the CSS row gap inside offsets when the window crosses the first row', () => {
    const keys = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    const heightByKey = Object.fromEntries(keys.map((key) => [key, 168]));
    const heights = keys.map(() => 168);
    const gapPx = 8;
    const shared = {
      keys,
      heightByKey,
      viewportHeight: 400,
      gapPx,
      overscanPx: 1400,
      minCount: 36,
      estimatePx: 168,
    };
    const atTop = resolveTranscriptWindow({ ...shared, scrollTop: 1555 });
    const down = resolveTranscriptWindow({ ...shared, scrollTop: 1580 });
    const back = resolveTranscriptWindow({ ...shared, scrollTop: 1555 });
    expect(atTop.start).toBe(0);
    expect(down.start).toBe(1);
    expect(down.padTop).toBe(168 + gapPx);
    expect(back).toEqual(atTop);

    const offsets = buildTranscriptOffsets(keys, heightByKey, gapPx, 168);
    for (const [layout, scrollTop] of [[atTop, 1555], [down, 1580]] as const) {
      const contentTop = renderedRowContentTop(layout, 10, heights, gapPx);
      expect(contentTop).toBe(offsets[10]);
      expect(contentTop! - scrollTop).toBe(offsets[10] - scrollTop);
    }
    const downJump = renderedRowContentTop(down, 10, heights, gapPx)! - renderedRowContentTop(atTop, 10, heights, gapPx)!;
    const upJump = renderedRowContentTop(back, 10, heights, gapPx)! - renderedRowContentTop(down, 10, heights, gapPx)!;
    expect(downJump).toBe(0);
    expect(upJump).toBe(0);
    expect((renderedRowContentTop(down, 10, heights, gapPx)! - 1580) - (renderedRowContentTop(atTop, 10, heights, gapPx)! - 1555)).toBe(-25);
  });

  it('keeps painted height equal to the full list at the start, middle, and end windows', () => {
    const count = 100;
    const gapPx = 8;
    const rowHeight = 168;
    const keys = Array.from({ length: count }, (_, index) => `row-${index}`);
    const heights = keys.map(() => rowHeight);
    const heightByKey = Object.fromEntries(keys.map((key, index) => [key, heights[index]]));
    const full = heights.reduce((sum, height) => sum + height, 0) + gapPx * (count - 1);
    const painted = (scrollTop: number) => {
      const layout = resolveTranscriptWindow({
        keys,
        heightByKey,
        scrollTop,
        viewportHeight: 400,
        gapPx,
        overscanPx: 1400,
        minCount: 36,
        estimatePx: rowHeight,
      });
      let inner = 0;
      for (let index = layout.start; index <= layout.end; index += 1) {
        inner += heights[index];
        if (index !== layout.end) inner += gapPx;
      }
      return { layout, height: layout.padTop + inner + layout.padBottom };
    };
    const top = painted(0);
    const middle = painted(8400);
    const end = painted(full);
    expect(top.layout.start).toBe(0);
    expect(top.layout.end).toBeLessThan(count - 1);
    expect(middle.layout.start).toBeGreaterThan(0);
    expect(middle.layout.end).toBeLessThan(count - 1);
    expect(end.layout.end).toBe(count - 1);
    expect(top.height).toBe(full);
    expect(middle.height).toBe(full);
    expect(end.height).toBe(full);
    expect(middle.layout.padBottom).toBeGreaterThan(gapPx);
  });
});
