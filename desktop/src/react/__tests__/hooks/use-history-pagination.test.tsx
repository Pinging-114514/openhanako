// @vitest-environment jsdom
import React, { useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { HISTORY_AUTOFILL_MAX_PAGES, needsHistoryPrefill, useHistoryPagination } from '../../hooks/use-history-pagination';
import type { ChatListItem } from '../../stores/chat-types';
const api = vi.hoisted(() => ({ more: vi.fn() }));
vi.mock('../../stores/session-actions', () => ({ loadMoreMessages: api.more }));
const PATH = '/chat/paging-test.jsonl';
const item = (id: string, role: 'user' | 'assistant'): ChatListItem => ({ type: 'message', data: role === 'user'
  ? { id, role, text: id } : { id, role, blocks: [{ type: 'text', source: id, html: id }] } });
let metrics: { height: number; viewport: number; top: number };
class RO { static callbacks: Array<() => void> = []; constructor(cb: () => void) { RO.callbacks.push(cb); } observe() {} disconnect() {} }
function Harness({ active = true, suspended = false }: { active?: boolean; suspended?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const session = useStore(s => s.chatSessions[PATH]);
  useHistoryPagination({ sessionPath: PATH, active, scrollRef: scroll, contentRef: content,
    items: session?.items || [], hasMore: session?.hasMore || false, loadingMore: session?.loadingMore || false, suspended: () => suspended });
  return <div data-testid="panel" ref={el => {
    scroll.current = el;
    if (el) Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => metrics.height },
      clientHeight: { configurable: true, get: () => metrics.viewport },
      scrollTop: { configurable: true, get: () => metrics.top, set: value => { metrics.top = value; } },
    });
  }}><div ref={content}>Transcript</div></div>;
}
async function flush(frames = 40) { for (let i = 0; i < frames; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20); }); }
function seed(items: ChatListItem[] = [item('100', 'assistant')], hasMore = true) {
  useStore.setState({ activeServerConnectionId: 'local', currentSessionPath: PATH, chatSessions: {
    [PATH]: { items, hasMore, oldestId: items[0]?.type === 'message' ? items[0].data.id : undefined, loadingMore: false },
  } } as never);
}
beforeEach(() => {
  vi.useFakeTimers();
  RO.callbacks = [];
  window.ResizeObserver = RO as unknown as typeof ResizeObserver;
  window.requestAnimationFrame = cb => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = id => window.clearTimeout(id);
  metrics = { height: 800, viewport: 800, top: 0 };
  api.more.mockReset();
  api.more.mockResolvedValue({ status: 'stalled', progressed: false });
  seed();
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded chat history pagination', () => {
  it('recognizes tool-only pages and short pages without requiring any scroll event', () => {
    expect(needsHistoryPrefill([item('100', 'assistant')], 1600, 800)).toBe(true);
    expect(needsHistoryPrefill([item('1', 'user')], 800, 800)).toBe(true);
    expect(needsHistoryPrefill([item('1', 'user')], 1600, 800)).toBe(false);
    expect(needsHistoryPrefill([], 800, 800)).toBe(false);
    expect(needsHistoryPrefill([item('1', 'user')], 0, 0)).toBe(false);
  });
  it('fills an initial assistant-only short page until a user turn is loaded, without a wheel/scroll', async () => {
    api.more.mockImplementation(async () => {
      metrics.height = 1500;
      useStore.getState().prependItems(PATH, [item('90', 'user')], true);
      return { status: 'loaded', progressed: true };
    });
    render(<Harness />);
    await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
    expect(api.more).toHaveBeenCalledWith(PATH, { limit: 200 });
  });
  it('recovers the user input hidden behind 57 assistant steps and a 50-record first page', async () => {
    const all = [item('0', 'user'), ...Array.from({ length: 57 }, (_, i) => item(String(i + 1), 'assistant'))];
    seed(all.slice(-50));
    api.more.mockImplementation(async () => {
      metrics.height = 1600;
      useStore.getState().prependItems(PATH, all.slice(0, 8), false);
      return { status: 'loaded', progressed: true, hasMore: false };
    });
    render(<Harness />); await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
    expect(useStore.getState().chatSessions[PATH].items.some(entry => entry.type === 'message' && entry.data.role === 'user')).toBe(true);
    expect(useStore.getState().chatSessions[PATH].hasMore).toBe(false);
  });

  it('also fills a tall assistant-only page to include the missing user input', async () => {
    metrics.height = 2000; metrics.top = 1000;
    api.more.mockImplementation(async () => { useStore.getState().prependItems(PATH, [item('90', 'user')], true); return { status: 'loaded', progressed: true }; });
    render(<Harness />); await flush(); expect(api.more).toHaveBeenCalledTimes(1);
  });
  it('does not page through a normal loaded user turn away from the top', async () => {
    seed([item('100', 'user'), item('101', 'assistant')]); metrics.height = 2000; metrics.top = 900;
    render(<Harness />); await flush(); expect(api.more).not.toHaveBeenCalled();
  });
  it('upward wheel at the already reached top requests history even when no scroll fires', async () => {
    seed([item('100', 'user')]); metrics.height = 2000;
    const view = render(<Harness />); await flush(); expect(api.more).not.toHaveBeenCalled();
    fireEvent.wheel(view.getByTestId('panel'), { deltaY: -120 }); await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
  });
  it('bounds a sequence of cursor-progressing pages that remain folded and contain no user', async () => {
    let cursor = 100;
    api.more.mockImplementation(async () => {
      cursor -= 1;
      useStore.getState().prependItems(PATH, [item(String(cursor), 'assistant')], true);
      return { status: 'loaded', progressed: true };
    });
    render(<Harness />); await flush(90);
    expect(api.more).toHaveBeenCalledTimes(HISTORY_AUTOFILL_MAX_PAGES);
  });
  it('retries a newer hydrate generation within the same bounded fill budget', async () => {
    api.more.mockImplementationOnce(async () => {
      useStore.getState().bumpLoadMessagesVersion(PATH);
      return { status: 'stale', progressed: false };
    }).mockImplementationOnce(async () => {
      metrics.height = 1600;
      useStore.getState().prependItems(PATH, [item('90', 'user')], false);
      return { status: 'loaded', progressed: true };
    });
    render(<Harness />); await flush();
    expect(api.more).toHaveBeenCalledTimes(2);
    expect(useStore.getState().chatSessions[PATH].hasMore).toBe(false);
  });

  it('stops a failed/no-progress auto fill and permits an explicit new upward attempt', async () => {
    api.more.mockResolvedValue({ status: 'failed', progressed: false });
    const view = render(<Harness />); await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
    act(() => RO.callbacks.forEach(cb => cb())); await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
    fireEvent.wheel(view.getByTestId('panel'), { deltaY: -100 }); await flush();
    expect(api.more).toHaveBeenCalledTimes(2);
    expect(api.more).toHaveBeenLastCalledWith(PATH, { limit: 200, retry: true });
  });
  it('does not start parallel fills during repeated wheel, resize and scroll notifications', async () => {
    let finish: ((value: unknown) => void) | undefined;
    api.more.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Harness />); await flush(3);
    for (let i = 0; i < 5; i++) { fireEvent.wheel(view.getByTestId('panel'), { deltaY: -100 }); fireEvent.scroll(view.getByTestId('panel')); }
    act(() => RO.callbacks.forEach(cb => cb())); await flush(3);
    expect(api.more).toHaveBeenCalledTimes(1);
    await act(async () => { finish?.({ status: 'stalled', progressed: false }); }); await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
  });
  it('does not auto load in inactive surfaces or while explicit jump/find owns pagination', async () => {
    const view = render(<Harness active={false} />); await flush(); expect(api.more).not.toHaveBeenCalled();
    view.rerender(<Harness active suspended />); await flush(); expect(api.more).not.toHaveBeenCalled();
    view.rerender(<Harness active />); fireEvent.wheel(view.getByTestId('panel'), { deltaY: -120 }); await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
  });
  it('ignores queued layout callbacks after unmount', async () => {
    const view = render(<Harness />); view.unmount(); await flush(); expect(api.more).not.toHaveBeenCalled();
  });
  it('recognizes touch and keyboard upward intent at the boundary', async () => {
    seed([item('100', 'user')]); metrics.height = 2000;
    const view = render(<Harness />); await flush();
    const panel = view.getByTestId('panel');
    fireEvent.touchStart(panel, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(panel, { touches: [{ clientY: 130 }] }); await flush();
    expect(api.more).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(panel, { key: 'PageUp' }); await flush(); expect(api.more).toHaveBeenCalledTimes(2);
  });
});
