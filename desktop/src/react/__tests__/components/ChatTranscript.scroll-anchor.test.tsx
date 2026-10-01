// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../../components/chat/ChatTranscript';
import { useStore } from '../../stores';
import type { ChatListItem, ContentBlock } from '../../stores/chat-types';

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

vi.mock('../../stores/message-turn-actions', () => ({
  retrySessionTurn: vi.fn(async () => true),
  forkSessionTurn: vi.fn(async () => null),
  activateForkedSession: vi.fn(async () => undefined),
}));

const sessionPath = '/session/scroll-anchor.jsonl';

function user(id: string, text: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      sourceEntryId: `entry-${id}`,
      role: 'user',
      timestamp: 1,
      text,
      textHtml: `<p>${text}</p>`,
    },
  };
}

describe('ChatTranscript scroll anchor chrome', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      agents: [],
      agentName: 'Hana',
      agentYuan: 'hana',
      streamingSessions: [],
      selectedIdsBySession: {},
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [],
        },
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the legacy fragment when no scroll parent is connected', () => {
    render(<ChatTranscript items={[user('m1', 'one'), user('m2', 'two')]} sessionPath={sessionPath} />);
    expect(document.querySelector('[data-transcript-key]')).toBeNull();
  });

  it('uses one stable list for a short transcript and a virtual window', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const scrollParentRef = createRef<HTMLDivElement>();
    scrollParentRef.current = panel;
    const { rerender } = render(
      <ChatTranscript
        items={[user('m1', 'one'), user('m2', 'two')]}
        sessionPath={sessionPath}
        scrollParentRef={scrollParentRef}
      />,
    );
    expect(document.querySelectorAll('[data-transcript-key]')).toHaveLength(2);
    expect(document.querySelector('[data-transcript-key="m1"]')).toHaveAttribute('data-transcript-first', 'true');
    expect(document.querySelector('[data-transcript-key="m2"]')).not.toHaveAttribute('data-transcript-first');
    const list = document.querySelector('[data-transcript-key="m1"]')?.parentElement;
    expect(list).not.toBeNull();

    const many = Array.from({ length: 40 }, (_, index) => user(`m-${index}`, `row ${index}`));
    rerender(
      <ChatTranscript
        items={many}
        sessionPath={sessionPath}
        scrollParentRef={scrollParentRef}
      />,
    );
    const mounted = document.querySelectorAll('[data-transcript-key]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(many.length);
    expect(document.querySelector('[data-transcript-key="m-0"]')?.parentElement).toBe(list);
    expect(document.querySelectorAll('[data-transcript-first="true"]')).toHaveLength(1);
    panel.remove();
  });

  it('does not give compaction rows a ghost slot in the anchored list', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const scrollParentRef = createRef<HTMLDivElement>();
    scrollParentRef.current = panel;
    const items: ChatListItem[] = [
      user('m1', 'one'),
      { type: 'compaction', id: 'compact-1', yuan: 'hanako' },
      user('m2', 'two'),
    ];
    render(
      <ChatTranscript items={items} sessionPath={sessionPath} scrollParentRef={scrollParentRef} />,
    );
    const keys = [...document.querySelectorAll('[data-transcript-key]')].map((node) => node.getAttribute('data-transcript-key'));
    expect(keys).toEqual(['m1', 'm2']);
    panel.remove();
  });
});

function thinking(content: string): ContentBlock {
  return { type: 'thinking', content, sealed: true };
}

function processAssistant(id: string, content: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      sourceEntryId: `entry-${id}`,
      role: 'assistant',
      timestamp: 1,
      blocks: [thinking(content)],
    },
  };
}

describe('ChatTranscript defers the fold the reader is still on', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      agents: [],
      agentName: 'Hana',
      agentYuan: 'hana',
      streamingSessions: [sessionPath],
      selectedIdsBySession: {},
      chatSessions: {
        [sessionPath]: { hasMore: false, loadingMore: false, items: [] },
      },
    } as never);
  });

  afterEach(() => cleanup());

  it('does not collapse a held process when paging finally prepends its missing user input', () => {
    const panel = document.createElement('div'); document.body.appendChild(panel);
    const scrollParentRef = createRef<HTMLDivElement>(); scrollParentRef.current = panel;
    const process = [processAssistant('now-1', '当前过程一'), processAssistant('now-2', '当前过程二'), processAssistant('now-3', '当前过程三')];
    const final: ChatListItem = { type: 'message', data: { id: 'answer', role: 'assistant', blocks: [{ type: 'text', html: '<p>Final answer</p>', source: 'Final answer' }] } };
    const props = { sessionPath, enableProcessFold: true, scrollParentRef, scrollAnchorOptions: { shouldPreserveAnchor: () => true } };
    const view = render(<ChatTranscript {...props} items={[...process, final]} />);
    act(() => { useStore.setState({ streamingSessions: [] } as never); });
    expect(document.querySelector('[data-transcript-key="now-1"]')).not.toBeNull();
    view.rerender(<ChatTranscript {...props} items={[user('question', 'previously unloaded question'), ...process, final]} />);
    expect(document.querySelector('[data-transcript-key="now-1"]')).not.toBeNull();
    expect(document.querySelector('[data-transcript-key="process-fold-now-1-now-3"]')).toBeNull();
    view.rerender(<ChatTranscript {...props} items={[user('question', 'question'), ...process, final, user('new-question', 'a genuinely new turn')]} />);
    expect(document.querySelector('[data-transcript-key="now-1"]')).toBeNull();
    panel.remove();
  });

  it('keeps the current process open when streaming ends away from the bottom', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const scrollParentRef = createRef<HTMLDivElement>();
    scrollParentRef.current = panel;
    let reading = true;
    const items: ChatListItem[] = [
      user('u1', 'earlier'),
      processAssistant('old-1', '旧过程一'),
      processAssistant('old-2', '旧过程二'),
      processAssistant('old-3', '旧过程三'),
      user('u2', 'current'),
      processAssistant('now-1', '当前过程一'),
      processAssistant('now-2', '当前过程二'),
      processAssistant('now-3', '当前过程三'),
    ];
    const view = render(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
        enableProcessFold
        scrollParentRef={scrollParentRef}
        scrollAnchorOptions={{ shouldPreserveAnchor: () => reading }}
      />,
    );
    expect(document.querySelector('[data-transcript-key="now-1"]')).not.toBeNull();
    expect(document.querySelector('[data-transcript-key="process-fold-old-1-old-3"]')).not.toBeNull();

    act(() => {
      useStore.setState({ streamingSessions: [] } as never);
    });
    expect(document.querySelector('[data-transcript-key="now-1"]')).not.toBeNull();
    expect(document.querySelector('[data-transcript-key="process-fold-old-1-old-3"]')).not.toBeNull();

    reading = false;
    view.rerender(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
        enableProcessFold
        scrollParentRef={scrollParentRef}
        scrollAnchorOptions={{ shouldPreserveAnchor: () => reading }}
      />,
    );
    expect(document.querySelector('[data-transcript-key="now-1"]')).toBeNull();
    expect(document.querySelector('[data-transcript-key="process-fold-now-1-now-3"]')).not.toBeNull();
    expect(document.querySelector('[data-transcript-key="process-fold-old-1-old-3"]')).not.toBeNull();

    reading = true;
    view.rerender(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
        enableProcessFold
        scrollParentRef={scrollParentRef}
        scrollAnchorOptions={{ shouldPreserveAnchor: () => reading }}
      />,
    );
    expect(document.querySelector('[data-transcript-key="now-1"]')).toBeNull();
    expect(document.querySelector('[data-transcript-key="process-fold-now-1-now-3"]')).not.toBeNull();
    panel.remove();
  });
});
