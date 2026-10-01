import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import { loadMoreMessages } from '../stores/session-actions';
import type { ChatListItem } from '../stores/chat-types';

export const HISTORY_TOP_THRESHOLD = 200;
export const HISTORY_AUTOFILL_PAGE_LIMIT = 200;
export const HISTORY_AUTOFILL_MAX_PAGES = 6;

export function needsHistoryPrefill(items: readonly ChatListItem[], height: number, viewport: number): boolean {
  if (!items.length || !(viewport > 0)) return false;
  return !items.some(item => item.type === 'message' && item.data.role === 'user')
    || height <= viewport + 1;
}

interface HistoryPaginationOptions {
  sessionPath: string;
  active: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  items: readonly ChatListItem[];
  hasMore: boolean;
  loadingMore: boolean;
  suspended?: () => boolean;
}

function nextPaint(): Promise<void> {
  return new Promise(resolve => {
    if (typeof window.requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

/** A bounded fill pump, separate from scroll ownership: this hook never writes scrollTop. */
export function useHistoryPagination(options: HistoryPaginationOptions): void {
  const connectionId = useStore(state => state.activeServerConnectionId ?? state.activeServerConnection?.connectionId ?? 'local');
  const latest = useRef(options);
  latest.current = options;
  const epoch = useRef(0);
  const scheduled = useRef<{ id: number; cancel: (id: number) => void } | null>(null);
  const live = useRef(false);
  const busy = useRef(false);
  const budget = useRef(HISTORY_AUTOFILL_MAX_PAGES);
  const wantsOlder = useRef(false);
  const explicitRetry = useRef(false);
  const blockedCursor = useRef<string | null>(null);
  const run = useRef<() => Promise<void>>(async () => {});

  const schedule = useCallback(() => {
    if (!live.current || scheduled.current !== null) return;
    let fired = false;
    const nativeFrame = typeof window.requestAnimationFrame === 'function';
    const request = nativeFrame
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0);
    const cancel = nativeFrame && typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame.bind(window) : window.clearTimeout.bind(window);
    const frame = request(() => {
      fired = true;
      scheduled.current = null;
      void run.current();
    });
    if (!fired) scheduled.current = { id: frame, cancel };
  }, []);

  run.current = async () => {
    const current = latest.current;
    const panel = current.scrollRef.current;
    if (!live.current || !current.active || !panel || current.suspended?.() || busy.current || budget.current <= 0) return;
    const store = useStore.getState();
    const session = sessionScopedValue(store, store.chatSessions, current.sessionPath);
    if (!session?.hasMore || session.loadingMore || !(panel.clientHeight > 0)) return;
    const cursor = session.oldestId == null ? '' : String(session.oldestId);
    if (!cursor || (blockedCursor.current === cursor && !explicitRetry.current)) return;
    const nearTop = panel.scrollTop < HISTORY_TOP_THRESHOLD;
    const fill = needsHistoryPrefill(session.items, panel.scrollHeight, panel.clientHeight);
    if (!nearTop) wantsOlder.current = false;
    if (!fill && !(wantsOlder.current && nearTop)) return;
    const version = epoch.current;
    const windowStamp = JSON.stringify([cursor, session.revision ?? null, sessionScopedValue(store, store._loadMessagesVersion, current.sessionPath) ?? 0]);
    busy.current = true;
    budget.current -= 1;
    const retry = explicitRetry.current;
    explicitRetry.current = false;
    try {
      const result: unknown = await loadMoreMessages(current.sessionPath, {
        limit: HISTORY_AUTOFILL_PAGE_LIMIT,
        ...(retry ? { retry: true } : {}),
      });
      // Give prepend rendering and reading-anchor correction ownership of this frame first.
      await nextPaint();
      if (epoch.current !== version) return;
      const afterStore = useStore.getState();
      const after = sessionScopedValue(afterStore, afterStore.chatSessions, current.sessionPath);
      const status = result && typeof result === 'object' && 'status' in result ? result.status : undefined;
      const nextCursor = after?.oldestId == null ? '' : String(after.oldestId);
      const progressed = !!after && nextCursor !== cursor;
      if (status === 'busy') return;
      if (!after || !after.hasMore) { wantsOlder.current = false; return; }
      if (status === 'stale') {
        const afterStamp = JSON.stringify([nextCursor, after.revision ?? null, sessionScopedValue(afterStore, afterStore._loadMessagesVersion, current.sessionPath) ?? 0]);
        // A newer hydrate generation is a new window, not a stuck server cursor.
        // Retry it within this pump's existing page budget; identical stale windows latch.
        blockedCursor.current = afterStamp !== windowStamp ? null : cursor;
        return;
      }
      if (!progressed || status === 'failed' || status === 'stalled') blockedCursor.current = cursor;
      else blockedCursor.current = null;
    } catch {
      if (epoch.current === version) blockedCursor.current = cursor;
    } finally {
      if (epoch.current === version) {
        busy.current = false;
        schedule();
      }
    }
  };

  useLayoutEffect(() => {
    epoch.current += 1;
    busy.current = false;
    budget.current = HISTORY_AUTOFILL_MAX_PAGES;
    blockedCursor.current = null;
    wantsOlder.current = false;
    explicitRetry.current = false;
    const panel = options.scrollRef.current;
    live.current = options.active && !!panel;
    if (!options.active || !panel) return;
    let touchY: number | null = null;
    let scrollbarGesture = false;
    let lastTop = panel.scrollTop;
    const requestFromUser = () => {
      budget.current = HISTORY_AUTOFILL_MAX_PAGES;
      blockedCursor.current = null;
      wantsOlder.current = true;
      if (!busy.current) explicitRetry.current = true;
      schedule();
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) requestFromUser(); };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y != null && y > touchY + 0.5) requestFromUser();
      if (y != null) touchY = y;
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) requestFromUser();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target !== panel) return;
      const gutter = Math.max(16, panel.offsetWidth - panel.clientWidth);
      if (event.clientX >= panel.getBoundingClientRect().right - gutter) {
        scrollbarGesture = true;
        budget.current = HISTORY_AUTOFILL_MAX_PAGES;
        blockedCursor.current = null;
        if (!busy.current) explicitRetry.current = true;
      }
    };
    const onPointerEnd = () => { scrollbarGesture = false; };
    const onScroll = () => {
      if (panel.scrollTop < lastTop - 0.5 || scrollbarGesture) wantsOlder.current = true;
      lastTop = panel.scrollTop;
      if (panel.scrollTop < HISTORY_TOP_THRESHOLD) wantsOlder.current = true;
      else wantsOlder.current = false;
      schedule();
    };
    panel.addEventListener('wheel', onWheel, { passive: true });
    panel.addEventListener('scroll', onScroll, { passive: true });
    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    panel.addEventListener('touchmove', onTouchMove, { passive: true });
    panel.addEventListener('keydown', onKey);
    panel.addEventListener('pointerdown', onPointer, { passive: true });
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });
    const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(schedule) : null;
    if (options.contentRef.current) observer?.observe(options.contentRef.current);
    observer?.observe(panel);
    schedule();
    return () => {
      epoch.current += 1;
      live.current = false;
      if (scheduled.current !== null) scheduled.current.cancel(scheduled.current.id);
      scheduled.current = null;
      observer?.disconnect();
      panel.removeEventListener('wheel', onWheel);
      panel.removeEventListener('scroll', onScroll);
      panel.removeEventListener('touchstart', onTouchStart);
      panel.removeEventListener('touchmove', onTouchMove);
      panel.removeEventListener('keydown', onKey);
      panel.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [connectionId, options.active, options.sessionPath, options.scrollRef, options.contentRef, schedule]);

  useLayoutEffect(() => { schedule(); }, [options.items, options.hasMore, options.loadingMore, options.active, schedule]);
}
