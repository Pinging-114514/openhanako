import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';

type ScrollMode = 'instant' | 'follow' | 'smooth';

interface ScrollToBottomOptions {
  mode?: ScrollMode;
  forceSticky?: boolean;
}

interface ScrollToTopOptions {
  mode?: Exclude<ScrollMode, 'follow'>;
}

interface UseContinuousBottomScrollOptions {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef?: RefObject<HTMLElement | null>;
  active?: boolean;
  stickyThreshold?: number;
  largeJumpPx?: number;
}

export interface ContinuousBottomScrollController {
  isStickyRef: MutableRefObject<boolean>;
  checkSticky: () => boolean;
  markSticky: () => void;
  cancelFollow: () => void;
  followBottom: () => void;
  scrollToBottom: (options?: ScrollToBottomOptions) => void;
  scrollToTop: (options?: ScrollToTopOptions) => void;
  /** Restore a reading anchor without treating the correction as a user's return to bottom. */
  restoreReadingPosition: (scrollTop: number) => void;
  /**
   * Arm a one-shot "instant landing": the very next bottom-follow (whether driven by the
   * ResizeObserver content callback or an explicit `followBottom()` call) snaps straight to the
   * bottom instead of animating, then disarms. Use this when switching/hydrating a session so the
   * first fill lands without a visible scroll animation. Later growth also pins. Honors sticky:
   * if the user has scrolled up, nothing moves.
   */
  armInstantLanding: () => void;
}

const DEFAULT_STICKY_THRESHOLD = 48;
const DEFAULT_LARGE_JUMP_PX = 720;
const SCROLL_EPSILON_PX = 0.5;

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function maxScrollTop(el: HTMLElement): number {
  return Math.max(0, finiteNumber(el.scrollHeight) - finiteNumber(el.clientHeight));
}

function distanceFromBottom(el: HTMLElement): number {
  return maxScrollTop(el) - finiteNumber(el.scrollTop);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useContinuousBottomScroll({
  scrollRef,
  contentRef,
  active = true,
  stickyThreshold = DEFAULT_STICKY_THRESHOLD,
  largeJumpPx: _largeJumpPx = DEFAULT_LARGE_JUMP_PX,
}: UseContinuousBottomScrollOptions): ContinuousBottomScrollController {
  const isStickyRef = useRef(true);
  const activeRef = useRef(active);
  const thresholdRef = useRef(stickyThreshold);
  const rafRef = useRef<number | null>(null);
  const followingRef = useRef(false);
  const instantLandingArmedRef = useRef(false);
  const programmaticScrollTopRef = useRef<number | null>(null);
  const lastObservedScrollHeightRef = useRef<number | null>(null);
  const userDisengagedRef = useRef(false);
  const lastUserScrollTopRef = useRef<number | null>(null);

  activeRef.current = active;
  thresholdRef.current = stickyThreshold;

  const stopFollow = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    followingRef.current = false;
  }, []);

  const setProgrammaticScrollTop = useCallback((el: HTMLElement, value: number) => {
    const safeValue = Math.max(0, Math.min(finiteNumber(value), maxScrollTop(el)));
    programmaticScrollTopRef.current = safeValue;
    lastUserScrollTopRef.current = safeValue;
    el.scrollTop = safeValue;
  }, []);

  const disengageFollow = useCallback(() => {
    stopFollow();
    userDisengagedRef.current = true;
    isStickyRef.current = false;
    instantLandingArmedRef.current = false;
  }, [stopFollow]);

  const checkSticky = useCallback(() => {
    if (userDisengagedRef.current) {
      isStickyRef.current = false;
      return false;
    }
    if (followingRef.current) return isStickyRef.current;
    const el = scrollRef.current;
    if (!el) return isStickyRef.current;
    const sticky = distanceFromBottom(el) <= finiteNumber(thresholdRef.current, DEFAULT_STICKY_THRESHOLD);
    isStickyRef.current = sticky;
    return sticky;
  }, [scrollRef]);

  const markSticky = useCallback(() => {
    userDisengagedRef.current = false;
    isStickyRef.current = true;
  }, []);

  const cancelFollow = useCallback(() => {
    disengageFollow();
  }, [disengageFollow]);

  const armInstantLanding = useCallback(() => {
    instantLandingArmedRef.current = true;
  }, []);

  const restoreReadingPosition = useCallback((scrollTop: number) => {
    const el = scrollRef.current;
    if (!el || !activeRef.current || isStickyRef.current) return;
    stopFollow();
    const previousBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    setProgrammaticScrollTop(el, scrollTop);
    if (previousBehavior) el.style.scrollBehavior = previousBehavior;
    else el.style.removeProperty('scroll-behavior');
  }, [scrollRef, setProgrammaticScrollTop, stopFollow]);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !activeRef.current || !isStickyRef.current) return;
    stopFollow();
    followingRef.current = true;
    setProgrammaticScrollTop(el, maxScrollTop(el));
  }, [scrollRef, setProgrammaticScrollTop, stopFollow]);

  const followBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !activeRef.current || !isStickyRef.current) return;

    const target = maxScrollTop(el);
    const delta = target - finiteNumber(el.scrollTop);
    if (Math.abs(delta) <= SCROLL_EPSILON_PX) {
      // Already at bottom: a no-op follow must NOT consume an armed instant landing — the arm is
      // reserved for the first *meaningful* growth (the async hydrate after a switch).
      setProgrammaticScrollTop(el, target);
      return;
    }

    if (instantLandingArmedRef.current) instantLandingArmedRef.current = false;
    // 贴底时直接钉在新底部。流式里高度会涨也会缩（markdown 重排、过程折叠、
    // 输入卡片 inset）；85ms 缓动会落后一截，下一帧再被浏览器 clamp 拉回去，就是上下抽。
    // overflow-anchor: none 管不了这条 JS 跟随。
    pinToBottom();
  }, [pinToBottom, scrollRef, setProgrammaticScrollTop]);

  const scrollToBottom = useCallback((options: ScrollToBottomOptions = {}) => {
    const el = scrollRef.current;
    if (!el) return;
    if (options.forceSticky) markSticky();
    stopFollow();

    const mode = options.mode ?? 'instant';
    const target = maxScrollTop(el);
    if (mode === 'instant' || prefersReducedMotion()) {
      setProgrammaticScrollTop(el, target);
      return;
    }
    if (mode === 'smooth') {
      if (typeof el.scrollTo === 'function') {
        el.scrollTo({ top: target, behavior: 'smooth' });
        return;
      }
      setProgrammaticScrollTop(el, target);
      return;
    }
    followBottom();
  }, [followBottom, markSticky, scrollRef, setProgrammaticScrollTop, stopFollow]);

  const scrollToTop = useCallback((options: ScrollToTopOptions = {}) => {
    const el = scrollRef.current;
    if (!el) return;
    cancelFollow();
    const mode = options.mode ?? 'smooth';
    if (mode === 'instant' || prefersReducedMotion()) {
      setProgrammaticScrollTop(el, 0);
      return;
    }
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setProgrammaticScrollTop(el, 0);
  }, [cancelFollow, scrollRef, setProgrammaticScrollTop]);

  useEffect(() => {
    if (!active) stopFollow();
  }, [active, stopFollow]);

  useEffect(() => stopFollow, [stopFollow]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return undefined;
    let scrollbarGesture = false;
    let scrollbarStartY = 0;

    const onScroll = () => {
      const expected = programmaticScrollTopRef.current;
      const current = finiteNumber(el.scrollTop);
      const previous = lastUserScrollTopRef.current;
      if (scrollbarGesture && previous !== null && current < previous - SCROLL_EPSILON_PX) {
        lastUserScrollTopRef.current = current;
        disengageFollow();
        return;
      }
      if (expected !== null && Math.abs(current - expected) <= 1) {
        const movedDownToBottom = previous !== null
          && current > previous + SCROLL_EPSILON_PX
          && distanceFromBottom(el) <= finiteNumber(thresholdRef.current, DEFAULT_STICKY_THRESHOLD);
        lastUserScrollTopRef.current = current;
        if (userDisengagedRef.current && movedDownToBottom) {
          userDisengagedRef.current = false;
          isStickyRef.current = true;
          return;
        }
        checkSticky();
        return;
      }
      const lastObserved = lastObservedScrollHeightRef.current;
      const heightDelta = lastObserved === null
        ? 0
        : finiteNumber(el.scrollHeight) - lastObserved;
      if (followingRef.current && heightDelta < -SCROLL_EPSILON_PX) {
        // 内容变矮时浏览器会 clamp / anchor，scrollTop 一起掉，不是手拖滚动条。
        lastUserScrollTopRef.current = current;
        return;
      }
      if (followingRef.current && heightDelta > SCROLL_EPSILON_PX) {
        const draggedUp = expected !== null && current < expected - 1;
        if (draggedUp) {
          lastUserScrollTopRef.current = current;
          disengageFollow();
          return;
        }
        lastUserScrollTopRef.current = current;
        return;
      }
      const movedUp = previous !== null && current < previous - SCROLL_EPSILON_PX;
      if (movedUp) {
        lastUserScrollTopRef.current = current;
        disengageFollow();
        return;
      }
      const movedDown = previous !== null && current > previous + SCROLL_EPSILON_PX;
      if (
        userDisengagedRef.current
        && movedDown
        && distanceFromBottom(el) <= finiteNumber(thresholdRef.current, DEFAULT_STICKY_THRESHOLD)
      ) {
        lastUserScrollTopRef.current = current;
        userDisengagedRef.current = false;
        isStickyRef.current = true;
        return;
      }
      lastUserScrollTopRef.current = current;
      if (userDisengagedRef.current) {
        isStickyRef.current = false;
        return;
      }
      if (followingRef.current && distanceFromBottom(el) > finiteNumber(thresholdRef.current, DEFAULT_STICKY_THRESHOLD)) {
        disengageFollow();
        return;
      }
      checkSticky();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) disengageFollow();
    };
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
      // A tap without movement must not disable an otherwise sticky transcript.
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== null && typeof nextY === 'number' && nextY > touchY + SCROLL_EPSILON_PX) disengageFollow();
      if (typeof nextY === 'number') touchY = nextY;
    };
    const onScrollbarPointerDown = (event: PointerEvent) => {
      if (event.target !== el) return;
      const rect = el.getBoundingClientRect();
      const gutter = Math.max(16, el.offsetWidth - el.clientWidth);
      if (event.clientX >= rect.right - gutter) {
        scrollbarGesture = true;
        scrollbarStartY = event.clientY;
      }
    };
    const onScrollbarPointerMove = (event: PointerEvent) => {
      if (scrollbarGesture && event.clientY < scrollbarStartY - SCROLL_EPSILON_PX) disengageFollow();
    };
    const onScrollbarPointerEnd = () => { scrollbarGesture = false; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        cancelFollow();
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('pointerdown', onScrollbarPointerDown, { passive: true });
    window.addEventListener('pointermove', onScrollbarPointerMove, { passive: true });
    window.addEventListener('pointerup', onScrollbarPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onScrollbarPointerEnd, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    onScroll();

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('pointerdown', onScrollbarPointerDown);
      window.removeEventListener('pointermove', onScrollbarPointerMove);
      window.removeEventListener('pointerup', onScrollbarPointerEnd);
      window.removeEventListener('pointercancel', onScrollbarPointerEnd);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [active, cancelFollow, checkSticky, disengageFollow, scrollRef, stopFollow]);

  useLayoutEffect(() => {
    const ResizeObserverImpl = window.ResizeObserver;
    const el = scrollRef.current;
    const target = contentRef?.current ?? scrollRef.current;
    if (!active || !el || !target || !ResizeObserverImpl) return undefined;

    lastObservedScrollHeightRef.current = finiteNumber(el.scrollHeight);

    const observer = new ResizeObserverImpl(() => {
      const previousScrollHeight = lastObservedScrollHeightRef.current;
      const nextScrollHeight = finiteNumber(el.scrollHeight);
      lastObservedScrollHeightRef.current = nextScrollHeight;

      if (
        previousScrollHeight !== null
        && nextScrollHeight < previousScrollHeight - SCROLL_EPSILON_PX
      ) {
        // Content shrank (e.g. process-fold collapse / typing-indicator removal at turn end).
        // If we were actively sticky, keep following to the new bottom instead of dropping out —
        // the user hadn't scrolled away, the content just got shorter underneath them.
        if (isStickyRef.current) {
          pinToBottom();
          return;
        }
        stopFollow();
        if (!userDisengagedRef.current) checkSticky();
        return;
      }

      followBottom();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active, checkSticky, contentRef, followBottom, pinToBottom, scrollRef, stopFollow]);

  return useMemo(() => ({
    isStickyRef,
    checkSticky,
    markSticky,
    cancelFollow,
    followBottom,
    scrollToBottom,
    scrollToTop,
    restoreReadingPosition,
    armInstantLanding,
  }), [armInstantLanding, cancelFollow, checkSticky, followBottom, markSticky, restoreReadingPosition, scrollToBottom, scrollToTop]);
}
