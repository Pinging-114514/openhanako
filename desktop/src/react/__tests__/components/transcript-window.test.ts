import { describe, expect, it } from 'vitest';
import { resolveTranscriptWindow } from '../../components/chat/transcript-window';

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
});
