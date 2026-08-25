/**
 * ChatArea — 聊天消息列表
 *
 * 每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 */

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { ChatMessageSurface, type ChatScrollButtonState } from './ChatMessageSurface';
import { ChatFindBar } from './ChatFindBar';
import styles from './Chat.module.css';

const MAX_ALIVE = 5;

export function ChatArea() {
  return (
    <>
      <PanelHost />
      <ChatFindBar />
      <ChatScrollFab />
    </>
  );
}

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  useEffect(() => {
    if (!currentPath) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev;
      if (prev.length >= MAX_ALIVE) {
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath]);

  if (welcomeVisible || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <ChatMessageSurface
          key={path}
          sessionPath={path}
          active={path === currentPath}
          onScrollButtonChange={setScrollButton}
        />
      ))}
    </>
  );
}

const _scrollBtn = {
  el: null as HTMLElement | null,
  showTop: false,
  showBottom: false,
  showSectionUp: false,
  showSectionDown: false,
  seekingTop: false,
  scrollToTop: null as (() => void) | null,
  scrollToBottom: null as (() => void) | null,
  scrollSectionUp: null as (() => void) | null,
  scrollSectionDown: null as (() => void) | null,
  listeners: [] as (() => void)[],
};

function setScrollButton(state: ChatScrollButtonState) {
  _scrollBtn.el = state.el;
  _scrollBtn.showTop = state.showTop;
  _scrollBtn.showBottom = state.showBottom;
  _scrollBtn.showSectionUp = state.showSectionUp;
  _scrollBtn.showSectionDown = state.showSectionDown;
  _scrollBtn.seekingTop = state.seekingTop;
  _scrollBtn.scrollToTop = state.scrollToTop;
  _scrollBtn.scrollToBottom = state.scrollToBottom;
  _scrollBtn.scrollSectionUp = state.scrollSectionUp;
  _scrollBtn.scrollSectionDown = state.scrollSectionDown;
  _scrollBtn.listeners.forEach(listener => listener());
}

function ChevronUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronsUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="17 11 12 6 7 11" />
      <polyline points="17 18 12 13 7 18" />
    </svg>
  );
}

function ChevronsDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="7 13 12 18 17 13" />
      <polyline points="7 6 12 11 17 6" />
    </svg>
  );
}

function ChatScrollFab() {
  const { t } = useI18n();
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const [showSectionUp, setShowSectionUp] = useState(false);
  const [showSectionDown, setShowSectionDown] = useState(false);
  const [seekingTop, setSeekingTop] = useState(false);
  useEffect(() => {
    const update = () => {
      setShowTop(_scrollBtn.showTop);
      setShowBottom(_scrollBtn.showBottom);
      setShowSectionUp(_scrollBtn.showSectionUp);
      setShowSectionDown(_scrollBtn.showSectionDown);
      setSeekingTop(_scrollBtn.seekingTop);
    };
    update();
    _scrollBtn.listeners.push(update);
    return () => { _scrollBtn.listeners = _scrollBtn.listeners.filter(listener => listener !== update); };
  }, []);

  if (!showTop && !showBottom && !showSectionUp && !showSectionDown) return null;
  return (
    <div
      className={styles.scrollFab}
      role="group"
      aria-label={t('chat.scroll.navAriaLabel')}
      data-testid="chat-scroll-fab"
    >
      {showTop && (
        <button
          type="button"
          className={styles.scrollFabBtn}
          aria-label={seekingTop ? t('chat.scroll.loadingTop') : t('chat.scroll.toTop')}
          aria-busy={seekingTop || undefined}
          disabled={seekingTop}
          data-testid="chat-scroll-to-top"
          onClick={() => { _scrollBtn.scrollToTop?.(); }}
        >
          <ChevronsUpIcon />
        </button>
      )}
      {showSectionUp && (
        <button
          type="button"
          className={styles.scrollFabBtn}
          aria-label={t('chat.scroll.sectionUp')}
          disabled={seekingTop}
          data-testid="chat-scroll-section-up"
          onClick={() => { _scrollBtn.scrollSectionUp?.(); }}
        >
          <ChevronUpIcon />
        </button>
      )}
      {showSectionDown && (
        <button
          type="button"
          className={styles.scrollFabBtn}
          aria-label={t('chat.scroll.sectionDown')}
          data-testid="chat-scroll-section-down"
          onClick={() => { _scrollBtn.scrollSectionDown?.(); }}
        >
          <ChevronDownIcon />
        </button>
      )}
      {showBottom && (
        <button
          type="button"
          className={styles.scrollFabBtn}
          aria-label={t('chat.scroll.toBottom')}
          data-testid="chat-scroll-to-bottom"
          onClick={() => { _scrollBtn.scrollToBottom?.(); }}
        >
          <ChevronsDownIcon />
        </button>
      )}
    </div>
  );
}
