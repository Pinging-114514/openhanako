import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import { loadAllOlderMessages, loadMoreMessages, reconcileCurrentSessionMessages } from '../../stores/session-actions';
import { useBoxSelection } from '../../hooks/use-box-selection';
import { useContinuousBottomScroll, type ContinuousBottomScrollController } from '../../hooks/use-continuous-bottom-scroll';
import { useHistoryPagination } from '../../hooks/use-history-pagination';
import { useI18n } from '../../hooks/use-i18n';
import { resolveLocateStep } from './locate-step';
import { applyFindMarks, clearFindMarks } from '../../utils/find-marks';
import type { ChatListItem } from '../../stores/chat-types';
import { ChatTimelineNavigator } from './ChatTimelineNavigator';
import { ChatTranscript } from './ChatTranscript';
import { TranscriptInlineError } from './TranscriptInlineError';
import { buildTimelineAnchors, type TimelineAnchor } from './timeline-anchors';
import styles from './Chat.module.css';

const EMPTY_ITEMS: ChatListItem[] = [];
const EMPTY_TIMELINE_ANCHORS: TimelineAnchor[] = [];
const SCROLL_THRESHOLD = 50;
const TIMELINE_HOVER_ZONE_PX = 64;
const TIMELINE_TOP_OFFSET_PX = 76;
const TIMELINE_HEIGHT_RATIO = 0.5;

export interface ChatScrollButtonState {
  el: HTMLElement | null;
  showTop: boolean;
  showBottom: boolean;
  showSectionUp: boolean;
  showSectionDown: boolean;
  seekingTop: boolean;
  scrollToTop: (() => void) | null;
  scrollToBottom: (() => void) | null;
  scrollSectionUp: (() => void) | null;
  scrollSectionDown: (() => void) | null;
}

function finiteScrollNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function listUserMessageIds(items: ChatListItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.type === 'message' && item.data.role === 'user') ids.push(item.data.id);
  }
  return ids;
}

function messageTopInPanel(panel: HTMLElement, element: HTMLElement): number {
  const panelRect = panel.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return finiteScrollNumber(panel.scrollTop) + finiteScrollNumber(rect.top) - finiteScrollNumber(panelRect.top);
}

function scrollPanelByPage(panel: HTMLElement, direction: -1 | 1): void {
  const page = Math.max(120, finiteScrollNumber(panel.clientHeight) * 0.85);
  const maxScroll = Math.max(0, finiteScrollNumber(panel.scrollHeight) - finiteScrollNumber(panel.clientHeight));
  const next = Math.min(maxScroll, Math.max(0, finiteScrollNumber(panel.scrollTop) + direction * page));
  if (typeof panel.scrollTo === 'function') {
    panel.scrollTo({ top: next, behavior: 'smooth' });
    return;
  }
  panel.scrollTop = next;
}

function readScrollButtonState(
  el: HTMLElement,
  bottomScroll: ContinuousBottomScrollController,
  opts: {
    hasMore: boolean;
    seekingTop: boolean;
    isStreaming: boolean;
    jumpToStart: () => void;
    scrollSectionUp: () => void;
    scrollSectionDown: () => void;
  },
): ChatScrollButtonState {
  const scrollTop = finiteScrollNumber(el.scrollTop);
  const maxScroll = Math.max(0, finiteScrollNumber(el.scrollHeight) - finiteScrollNumber(el.clientHeight));
  const canScroll = maxScroll > SCROLL_THRESHOLD;
  const sticky = bottomScroll.checkSticky();
  const awayFromLoadedTop = scrollTop > SCROLL_THRESHOLD;
  const showTop = opts.seekingTop || awayFromLoadedTop || opts.hasMore;
  const showBottom = canScroll && !sticky;
  return {
    el,
    showTop,
    showBottom,
    showSectionUp: showTop,
    showSectionDown: showBottom,
    seekingTop: opts.seekingTop,
    scrollToTop: opts.jumpToStart,
    scrollToBottom: () => {
      bottomScroll.scrollToBottom({ mode: opts.isStreaming ? 'instant' : 'smooth', forceSticky: true });
    },
    scrollSectionUp: opts.scrollSectionUp,
    scrollSectionDown: opts.scrollSectionDown,
  };
}

export interface ChatMessageSurfaceProps {
  sessionPath: string;
  active?: boolean;
  variant?: 'default' | 'card';
  onScrollButtonChange?: (state: ChatScrollButtonState) => void;
}

export const ChatMessageSurface = memo(function ChatMessageSurface({
  sessionPath,
  active = true,
  variant = 'default',
  onScrollButtonChange,
}: ChatMessageSurfaceProps) {
  const items = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.items || EMPTY_ITEMS);
  const hasMore = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.hasMore ?? false);
  const loadingMore = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.loadingMore ?? false);
  const isSessionStreaming = useStore(s => sessionScopedListIncludes(s, s.streamingSessions, sessionPath));
  const inlineError = useStore(s => sessionScopedValue(s, s.inlineErrors, sessionPath) ?? null);
  const sessionAgentId = useStore(s => s.sessions.find(se => se.path === sessionPath)?.agentId ?? null);
  const sessionReadOnly = useStore(s => s.sessions.find(se => se.path === sessionPath)?.agentDeleted === true);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());
  const [timelineRailVisible, setTimelineRailVisible] = useState(false);
  const [timelinePrepared, setTimelinePrepared] = useState(false);
  const bottomScroll = useContinuousBottomScroll({
    scrollRef: ref,
    contentRef,
    active,
    stickyThreshold: SCROLL_THRESHOLD,
  });
  const timelineAnchors = useMemo(() => (
    active && timelinePrepared ? buildTimelineAnchors(items) : EMPTY_TIMELINE_ANCHORS
  ), [active, items, timelinePrepared]);
  const emitScrollButton = useCallback((state: ChatScrollButtonState) => {
    onScrollButtonChange?.(state);
  }, [onScrollButtonChange]);
  const [seekingTop, setSeekingTop] = useState(false);
  const seekingTopRef = useRef(false);
  const seekAbortRef = useRef<AbortController | null>(null);
  const surfaceActiveRef = useRef(active);
  surfaceActiveRef.current = active;
  const cancelSeekTopRef = useRef(false);
  const [sectionPinId, setSectionPinId] = useState<string | null>(null);
  const pendingSectionIdRef = useRef<string | null>(null);
  const pendingSectionFromRef = useRef<string | null>(null);
  const sectionScrollInstantRef = useRef(false);
  const navigationHoldRef = useRef(false);
  const navigationTimerRef = useRef<number | null>(null);
  const clearNavigationHold = useCallback(() => {
    navigationHoldRef.current = false;
    if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = null;
  }, []);
  const beginNavigation = useCallback(() => {
    bottomScroll.cancelFollow();
    clearNavigationHold();
    navigationHoldRef.current = true;
    // scrollend releases normal navigation; the timeout also covers a no-op scroll or old browser.
    navigationTimerRef.current = window.setTimeout(clearNavigationHold, 1200);
  }, [bottomScroll, clearNavigationHold]);
  const pagingSuspended = useCallback(() => {
    const locate = useStore.getState().pendingMessageLocate;
    return seekingTopRef.current || navigationHoldRef.current || !!pendingSectionIdRef.current
      || !!pendingSectionFromRef.current || locate?.sessionPath === sessionPath;
  }, [sessionPath]);
  const scrollAnchorOptions = useMemo(() => ({
    active,
    shouldPreserveAnchor: () => active && !bottomScroll.isStickyRef.current && !pagingSuspended(),
    restoreScrollTop: (top: number) => bottomScroll.restoreReadingPosition(top),
  }), [active, bottomScroll, pagingSuspended]);
  useHistoryPagination({ sessionPath, active, scrollRef: ref, contentRef, items, hasMore, loadingMore, suspended: pagingSuspended });
  const cancelNavigationFromUser = useCallback(() => {
    clearNavigationHold();
    pendingSectionFromRef.current = null;
    pendingSectionIdRef.current = null;
    setSectionPinId(null);
    if (seekingTopRef.current) {
      cancelSeekTopRef.current = true;
      seekAbortRef.current?.abort();
      seekAbortRef.current = null;
      seekingTopRef.current = false;
      setSeekingTop(false);
    }
  }, [clearNavigationHold]);
  useLayoutEffect(() => {
    clearNavigationHold();
    setSeekingTop(false);
    const panel = ref.current;
    if (!active || !panel) return;
    panel.addEventListener('scrollend', clearNavigationHold);
    panel.addEventListener('wheel', cancelNavigationFromUser, { capture: true, passive: true });
    panel.addEventListener('touchmove', cancelNavigationFromUser, { capture: true, passive: true });
    panel.addEventListener('keydown', cancelNavigationFromUser, true);
    return () => {
      clearNavigationHold();
      cancelSeekTopRef.current = true;
      seekAbortRef.current?.abort();
      seekAbortRef.current = null;
      seekingTopRef.current = false;
      panel.removeEventListener('scrollend', clearNavigationHold);
      panel.removeEventListener('wheel', cancelNavigationFromUser, true);
      panel.removeEventListener('touchmove', cancelNavigationFromUser, true);
      panel.removeEventListener('keydown', cancelNavigationFromUser, true);
    };
  }, [active, cancelNavigationFromUser, clearNavigationHold]);
  const scrollToMessage = useCallback((messageId: string, mode: 'smooth' | 'instant' = 'smooth'): boolean => {
    const panel = ref.current;
    const target = messageElementsRef.current.get(messageId);
    if (!panel || !target) return false;
    beginNavigation();
    const maxScroll = Math.max(0, finiteScrollNumber(panel.scrollHeight) - finiteScrollNumber(panel.clientHeight));
    const top = Math.min(maxScroll, Math.max(0, messageTopInPanel(panel, target) - 16));
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = mode === 'instant' || reduceMotion ? 'auto' : 'smooth';
    if (typeof panel.scrollTo === 'function') {
      panel.scrollTo({ top, behavior });
    } else {
      panel.scrollTop = top;
    }
    return true;
  }, [beginNavigation]);
  const queueSectionScroll = useCallback((messageId: string, mode: 'smooth' | 'instant' = 'smooth') => {
    pendingSectionIdRef.current = messageId;
    sectionScrollInstantRef.current = mode === 'instant';
    setSectionPinId(messageId);
    if (scrollToMessage(messageId, mode)) pendingSectionIdRef.current = null;
  }, [scrollToMessage]);
  const scrollSectionUp = useCallback(() => {
    const panel = ref.current;
    if (!panel || seekingTopRef.current) return;
    bottomScroll.cancelFollow();
    const ids = listUserMessageIds(items);
    const threshold = finiteScrollNumber(panel.scrollTop) - 24;
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const element = messageElementsRef.current.get(ids[i]);
      if (element && messageTopInPanel(panel, element) < threshold) {
        queueSectionScroll(ids[i]);
        return;
      }
    }
    const firstVisible = ids.find((id) => messageElementsRef.current.has(id));
    const firstIndex = firstVisible ? ids.indexOf(firstVisible) : 0;
    if (firstIndex > 0) {
      queueSectionScroll(ids[firstIndex - 1]);
      return;
    }
    if (hasMore && firstVisible) {
      pendingSectionFromRef.current = firstVisible;
      setSectionPinId(firstVisible);
      loadMoreMessages(sessionPath);
      return;
    }
    beginNavigation();
    scrollPanelByPage(panel, -1);
  }, [beginNavigation, bottomScroll, hasMore, items, queueSectionScroll, sessionPath]);
  const scrollSectionDown = useCallback(() => {
    const panel = ref.current;
    if (!panel) return;
    bottomScroll.cancelFollow();
    const ids = listUserMessageIds(items);
    const threshold = finiteScrollNumber(panel.scrollTop) + 24;
    for (const id of ids) {
      const element = messageElementsRef.current.get(id);
      if (element && messageTopInPanel(panel, element) > threshold) {
        queueSectionScroll(id);
        return;
      }
    }
    const mounted = ids.filter((id) => messageElementsRef.current.has(id));
    const lastMounted = mounted[mounted.length - 1];
    const lastIndex = lastMounted ? ids.indexOf(lastMounted) : -1;
    if (lastIndex >= 0 && lastIndex < ids.length - 1) {
      queueSectionScroll(ids[lastIndex + 1]);
      return;
    }
    beginNavigation();
    scrollPanelByPage(panel, 1);
  }, [beginNavigation, bottomScroll, items, queueSectionScroll]);
  const jumpToStart = useCallback(() => {
    const panel = ref.current;
    if (!panel || !surfaceActiveRef.current || seekingTopRef.current) return;
    seekingTopRef.current = true;
    cancelSeekTopRef.current = false;
    const controller = new AbortController();
    seekAbortRef.current = controller;
    setSeekingTop(true);
    bottomScroll.cancelFollow();
    const cancel = () => {
      cancelSeekTopRef.current = true;
      controller.abort();
    };
    panel.addEventListener('wheel', cancel, { passive: true, once: true });
    panel.addEventListener('touchstart', cancel, { passive: true, once: true });
    void loadAllOlderMessages(sessionPath, {
      signal: controller.signal,
      shouldContinue: () => !controller.signal.aborted && !cancelSeekTopRef.current && surfaceActiveRef.current,
    })
      .catch((err) => {
        console.warn('[chat] load older messages for jump-to-start failed:', err);
      })
      .finally(() => {
        panel.removeEventListener('wheel', cancel);
        panel.removeEventListener('touchstart', cancel);
        if (seekAbortRef.current !== controller) return;
        seekAbortRef.current = null;
        const skipped = controller.signal.aborted || cancelSeekTopRef.current || !surfaceActiveRef.current;
        seekingTopRef.current = false;
        setSeekingTop(false);
        if (!skipped) {
          beginNavigation();
          bottomScroll.scrollToTop({ mode: 'smooth' });
        }
      });
  }, [beginNavigation, bottomScroll, sessionPath]);
  const registerMessageElement = useCallback((messageId: string, element: HTMLDivElement | null) => {
    if (element) {
      messageElementsRef.current.set(messageId, element);
    } else {
      messageElementsRef.current.delete(messageId);
    }
  }, []);
  const orderedIds = useMemo(() => {
    const ids: string[] = [];
    for (const it of items) {
      if (it.type === 'message') ids.push(it.data.id);
    }
    return ids;
  }, [items]);
  const boxSelection = useBoxSelection({ messageElementsRef, orderedIds, sessionPath, active });
  // 聊天选区提交不在组件层挂 mouseup/keyup：document 级 initQuotedSelectionLifecycle
  // 已按 surface 统一捕获（主窗口 + 每个拆窗子窗各注册一次，且查询各自 document 的
  // 原生选区）。组件层再挂一份既冗余、又会在子窗口里误查主窗口 document。这里只需
  // 标注 data-chat-selection-root / data-session-path 供 document lifecycle 定位。
  const handleShellPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xFromRight = rect.right - event.clientX;
    const yFromTop = event.clientY - rect.top;
    const inRailX = xFromRight >= 0 && xFromRight <= TIMELINE_HOVER_ZONE_PX;
    const inRailY = yFromTop >= TIMELINE_TOP_OFFSET_PX
      && yFromTop <= TIMELINE_TOP_OFFSET_PX + rect.height * TIMELINE_HEIGHT_RATIO;
    setTimelineRailVisible(inRailX && inRailY);
    if (active && inRailX && inRailY) setTimelinePrepared(true);
  }, [active]);
  const handleShellPointerLeave = useCallback(() => {
    setTimelineRailVisible(false);
  }, []);

  useEffect(() => {
    if (active) return;
    setTimelineRailVisible(false);
    setTimelinePrepared(false);
  }, [active]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const publishScrollButton = () => {
      if (!active) return;
      emitScrollButton(readScrollButtonState(el, bottomScroll, {
        hasMore,
        seekingTop,
        isStreaming: isSessionStreaming,
        jumpToStart,
        scrollSectionUp,
        scrollSectionDown,
      }));
    };
    const onScroll = () => {
      publishScrollButton();
      el.classList.add(styles['is-scrolling']);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        el.classList.remove(styles['is-scrolling']);
      }, 800);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    publishScrollButton();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (hideTimer) clearTimeout(hideTimer);
      emitScrollButton({
        el: null,
        showTop: false,
        showBottom: false,
        showSectionUp: false,
        showSectionDown: false,
        seekingTop: false,
        scrollToTop: null,
        scrollToBottom: null,
        scrollSectionUp: null,
        scrollSectionDown: null,
      });
    };
  }, [active, bottomScroll, emitScrollButton, hasMore, isSessionStreaming, jumpToStart, scrollSectionDown, scrollSectionUp, seekingTop, sessionPath]);

  // Reading-position correction belongs to ChatTranscript's stable anchor, not total page height.
  useLayoutEffect(() => {
    const fromId = pendingSectionFromRef.current;
    if (!fromId || loadingMore) return;
    const ids = listUserMessageIds(items);
    const fromIndex = ids.indexOf(fromId);
    pendingSectionFromRef.current = null;
    if (fromIndex > 0) queueSectionScroll(ids[fromIndex - 1], 'instant');
  }, [items, loadingMore, queueSectionScroll]);

  useLayoutEffect(() => {
    const messageId = pendingSectionIdRef.current;
    if (!messageId) return;
    const mode = sectionScrollInstantRef.current ? 'instant' : 'smooth';
    if (scrollToMessage(messageId, mode)) pendingSectionIdRef.current = null;
  }, [items, sectionPinId, scrollToMessage]);

  useLayoutEffect(() => {
    if (active) bottomScroll.armInstantLanding();
  }, [active, bottomScroll]);

  const scrolledOnce = useRef(false);
  useLayoutEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      scrolledOnce.current = true;
    }
  }, [bottomScroll, items.length]);

  const prevLen = useRef(items.length);
  const prevLastId = useRef<string | undefined>(undefined);
  useEffect(() => {
    let lastId: string | undefined;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.type === 'message') {
        lastId = item.data.id;
        break;
      }
    }
    const grew = items.length > prevLen.current;
    const prepended = grew && lastId === prevLastId.current;
    const appended = grew && lastId !== prevLastId.current;
    prevLen.current = items.length;
    prevLastId.current = lastId;
    if (!appended || !active || prepended || seekingTopRef.current || pendingSectionFromRef.current) return;
    const last = items[items.length - 1];
    if (last?.type === 'message' && last.data.role === 'user') {
      bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      return;
    }
    bottomScroll.followBottom();
  }, [items, items.length, active, bottomScroll]);

  const { t } = useI18n();
  const pendingLocate = useStore(s => s.pendingMessageLocate);
  const pinnedMessageIds = useMemo(() => {
    const ids: string[] = [];
    if (sectionPinId) ids.push(sectionPinId);
    if (pendingLocate && pendingLocate.sessionPath === sessionPath) {
      ids.push(String(pendingLocate.messageIndex));
    }
    return ids;
  }, [pendingLocate, sectionPinId, sessionPath]);
  const findState = useStore(s => sessionScopedValue(s, s.chatFindBySession, sessionPath));
  // 定位意图的进度守卫：同一意图下"同种 stall 无进展"即放弃，防无限重试——
  // load-more 后 oldestId 未前进，或 refresh（reconcile）后 revision 未前进
  const locateProgressRef = useRef<{ key: string; lastOldestId?: string; lastRevision?: string | null } | null>(null);
  // 查找高亮：流式期间同一查询不重复标注 / 从未标注过则 clear 短路
  const markKeyRef = useRef<string | null>(null);
  const hadMarksRef = useRef(false);

  // —— 定位意图消费：补加载 → 滚动 → flash ——
  // 消费侧校验 sessionPath：意图不属于本 surface 就忽略（状态归属纪律）。
  // 卡片实例是嵌入式投影，不响应全局导航意图。
  useEffect(() => {
    if (variant === 'card') return;
    if (!pendingLocate) {
      locateProgressRef.current = null;
      return;
    }
    if (!active || pendingLocate.sessionPath !== sessionPath) return;
    const intentKey = `${pendingLocate.sessionPath}#${pendingLocate.messageIndex}#${pendingLocate.term}`;
    if (locateProgressRef.current && locateProgressRef.current.key !== intentKey) {
      locateProgressRef.current = null;
    }
    const cleanups: Array<() => void> = [];
    // 意图存在期间用户手动干预（滚轮/触摸）即取消，不跟用户抢滚动
    const panel = ref.current;
    if (panel) {
      const cancelByUser = () => {
        useStore.getState().clearMessageLocate();
        locateProgressRef.current = null;
      };
      panel.addEventListener('wheel', cancelByUser, { passive: true, once: true });
      panel.addEventListener('touchstart', cancelByUser, { passive: true, once: true });
      cleanups.push(() => {
        panel.removeEventListener('wheel', cancelByUser);
        panel.removeEventListener('touchstart', cancelByUser);
      });
    }
    const targetId = String(pendingLocate.messageIndex);
    const element = messageElementsRef.current.get(targetId) ?? null;
    const state = useStore.getState();
    const session = sessionScopedValue(state, state.chatSessions, sessionPath);
    if (!session) {
      // session 尚未 initSession：hydrate 落地（items 变化）会重触发本 effect
      return () => {
        for (const dispose of cleanups) dispose();
      };
    }
    const giveUp = () => {
      const latest = useStore.getState();
      latest.addToast(t('chat.find.locateFailed'), 'error', 4000);
      latest.clearMessageLocate();
      locateProgressRef.current = null;
    };
    const finishScroll = (target: HTMLDivElement) => {
      const scrollPanel = ref.current;
      if (!scrollPanel) {
        console.warn('[chat-find] locate scroll skipped: panel element missing');
        useStore.getState().clearMessageLocate();
        locateProgressRef.current = null;
        return;
      }
      // 退出贴底跟随，防止流式 ResizeObserver 立刻把视口拽回底部
      beginNavigation();
      const panelRect = scrollPanel.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const maxScroll = Math.max(0, scrollPanel.scrollHeight - scrollPanel.clientHeight);
      const targetTop = Math.min(maxScroll, Math.max(0, scrollPanel.scrollTop + rect.top - panelRect.top - 16));
      const reduceMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scrollPanel.scrollTo({ top: targetTop, behavior: reduceMotion ? 'auto' : 'smooth' });
      target.classList.remove(styles.locateFlash);
      // 强制 reflow 重启动画（连续定位同一条消息时）
      void target.offsetWidth;
      target.classList.add(styles.locateFlash);
      useStore.getState().clearMessageLocate();
      locateProgressRef.current = null;
    };
    // items 尾部向前第一个数字（canonical）id；全 live id（新建会话）时 null
    let newestNumericId: number | null = null;
    for (let i = session.items.length - 1; i >= 0; i -= 1) {
      const it = session.items[i];
      if (it.type !== 'message') continue;
      const numeric = Number(it.data.id);
      if (Number.isFinite(numeric)) {
        newestNumericId = numeric;
        break;
      }
    }
    const step = resolveLocateStep({
      targetIndex: pendingLocate.messageIndex,
      elementPresent: !!element,
      itemPresent: session.items.some(it => it.type === 'message' && it.data.id === targetId),
      oldestId: session.oldestId,
      hasMore: session.hasMore,
      loadingMore: session.loadingMore,
      newestNumericId,
    });
    const progress = locateProgressRef.current?.key === intentKey ? locateProgressRef.current : null;
    if (step === 'load-more') {
      if (progress && progress.lastOldestId !== undefined && progress.lastOldestId === session.oldestId) {
        // 上一轮 load-more 后 oldestId 没前进（失败或空页），停止重试
        giveUp();
      } else {
        locateProgressRef.current = { ...progress, key: intentKey, lastOldestId: session.oldestId };
        loadMoreMessages(sessionPath);
      }
    } else if (step === 'refresh') {
      const sessionRevision = session.revision ?? null;
      if (progress && progress.lastRevision !== undefined && progress.lastRevision === sessionRevision) {
        // 上一轮 reconcile 后 revision 未前进（流式中 no-op / 目标本就不存在），
        // 停止重试给出反馈；流式结束后用户重新触发即可成功
        giveUp();
      } else {
        locateProgressRef.current = { ...progress, key: intentKey, lastRevision: sessionRevision };
        void reconcileCurrentSessionMessages('chat-find-locate');
      }
    } else if (step === 'give-up') {
      giveUp();
    } else if (step === 'wait-element') {
      // items 里有但 DOM 未注册。翻页在途交给 loadingMore 依赖重触发；
      // 否则有界等待：双帧后仍未注册（折叠块内 / 渲染为 null）则放弃。
      if (!session.loadingMore) {
        let raf2 = 0;
        const raf1 = requestAnimationFrame(() => {
          raf2 = requestAnimationFrame(() => {
            // 复核意图身份：两帧窗口内意图可能已被取消或替换，不误清新意图
            const currentIntent = useStore.getState().pendingMessageLocate;
            const currentKey = currentIntent
              ? `${currentIntent.sessionPath}#${currentIntent.messageIndex}#${currentIntent.term}`
              : null;
            if (currentKey !== intentKey) return;
            const settled = messageElementsRef.current.get(targetId);
            if (settled) finishScroll(settled);
            else giveUp();
          });
        });
        cleanups.push(() => {
          cancelAnimationFrame(raf1);
          cancelAnimationFrame(raf2);
        });
      }
    } else if (step === 'scroll' && element) {
      finishScroll(element);
    }
    // step === 'wait'：items / loadingMore 变化经依赖数组重触发本 effect
    return () => {
      for (const dispose of cleanups) dispose();
    };
  }, [active, pendingLocate, items, sessionPath, loadingMore, variant, t, bottomScroll, beginNavigation]);

  // —— 查找高亮：查找条打开期间对已加载消息词级 mark ——
  useEffect(() => {
    if (variant === 'card') return; // 卡片投影不做查找标注
    if (!active) return; // 非 active 实例不跑；切回 active 时依赖变化自然重跑
    const container = contentRef.current;
    if (!container) return;
    if (!findState?.open || !findState.query.trim()) {
      markKeyRef.current = null;
      if (hadMarksRef.current) {
        clearFindMarks(container, 'chat-find-mark');
        hadMarksRef.current = false;
      }
      return;
    }
    const markKey = `${findState.query}|${(findState.tokens ?? []).join(',')}`;
    // 流式期间同一查询已标注过：不重跑 TreeWalker，防与流式 reconcile 打架循环；
    // 流式结束边沿（isSessionStreaming 翻 false）经依赖重跑补标。
    if (isSessionStreaming && markKeyRef.current === markKey) return;
    const terms = [findState.query.trim(), ...findState.tokens];
    // rAF 合并：items 高频变化（流式）时不在同帧重复跑 TreeWalker
    const raf = requestAnimationFrame(() => {
      // scope 到消息正文（MarkdownContent 直渲根）：不碰 React 直渲文本节点
      //（时间戳 / 按钮 / 折叠标题等），改写它们会与 React reconcile 冲突
      applyFindMarks(container, terms, 'chat-find-mark', { scopeSelector: '[data-find-markable]' });
      markKeyRef.current = markKey;
      hadMarksRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [variant, active, findState?.open, findState?.query, findState?.tokens, items, isSessionStreaming]);

  const shellClassName = variant === 'card'
    ? `${styles.sessionShell} ${styles.cardSessionShell}`
    : `${styles.sessionShell}${active ? ` ${styles.sessionShellActive}` : ''}`;

  return (
    <div
      className={shellClassName}
      data-active={active ? 'true' : 'false'}
      onPointerMove={handleShellPointerMove}
      onPointerLeave={handleShellPointerLeave}
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div
        ref={ref}
        className={styles.sessionPanel}
        data-chat-selection-root=""
        data-session-path={sessionPath}
        onPointerDown={boxSelection.onPointerDown}
        onClickCapture={boxSelection.onClickCapture}
      >
        <div
          ref={contentRef}
          className={`${styles.sessionMessages}${boxSelection.selectionModeActive ? ` ${styles.selectionModeActive}` : ''}`}
        >
          {hasMore && (
            <div className={styles.loadMoreHint}>
              {loadingMore ? '...' : ''}
            </div>
          )}
          <ChatTranscript
            items={items}
            sessionPath={sessionPath}
            agentId={sessionAgentId}
            readOnly={sessionReadOnly}
            registerMessageElement={registerMessageElement}
            enableProcessFold
            scrollParentRef={variant === 'card' ? undefined : ref}
            pinnedMessageIds={pinnedMessageIds}
            scrollAnchorOptions={scrollAnchorOptions}
          />
          {inlineError && <TranscriptInlineError error={inlineError} />}
          {isSessionStreaming && (
            <div className={styles.typingIndicator} />
          )}
          <div className={styles.sessionFooter} />
        </div>
      </div>
      <ChatTimelineNavigator
        anchors={timelineAnchors}
        scrollRef={ref}
        contentRef={contentRef}
        messageElementsRef={messageElementsRef}
        active={active}
        railVisible={timelineRailVisible}
        onNavigate={beginNavigation}
      />
      {boxSelection.box && (
        <div
          className={styles.selectionBox}
          style={{
            left: boxSelection.box.left,
            top: boxSelection.box.top,
            width: boxSelection.box.right - boxSelection.box.left,
            height: boxSelection.box.bottom - boxSelection.box.top,
          }}
        />
      )}
    </div>
  );
});
