// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageSurface } from '../../../components/chat/ChatMessageSurface';
import type { ChatListItem } from '../../../stores/chat-types';
import { useStore } from '../../../stores';

vi.mock('../../../components/chat/ChatTranscript', () => ({
  ChatTranscript: ({ items }: { items: ChatListItem[] }) => (
    <div data-testid="transcript">
      {items.map((item) => item.type === 'message' ? (
        <div key={item.data.id}>{item.data.text}</div>
      ) : null)}
    </div>
  ),
}));

vi.mock('../../../components/chat/ChatTimelineNavigator', () => ({
  ChatTimelineNavigator: () => null,
}));

vi.mock('../../../stores/session-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stores/session-actions')>();
  return { ...actual, loadMoreMessages: vi.fn(), reconcileCurrentSessionMessages: vi.fn() };
});

const SESSION = '/chat/inline-error.jsonl';

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function message(id: string, text = `msg-${id}`): ChatListItem {
  return {
    type: 'message',
    data: { id, role: 'assistant', text, textHtml: `<p>${text}</p>` },
  };
}

describe('ChatMessageSurface · transcript inline error', () => {
  beforeEach(() => {
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    (window as unknown as { t: (path: string) => string }).t = (path: string) => path;
    useStore.setState({
      chatSessions: {
        [SESSION]: {
          items: [message('a1', 'latest assistant output')],
          hasMore: false,
          loadingMore: false,
          oldestId: 'a1',
        },
      },
      sessions: [{ path: SESSION, agentId: 'hana', title: null, firstMessage: '', modified: '', messageCount: 1 }],
      streamingSessions: [],
      inlineErrors: {
        [SESSION]: {
          text: '模型现在过载了，稍后再试',
          detail: 'The model is currently overloaded',
          code: 'overloaded',
        },
      },
      pendingMessageLocate: null,
      chatFindBySession: {},
      toasts: [],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as unknown as { t?: unknown }).t;
  });

  it('renders the session error after the latest transcript output, not above the input', () => {
    render(<ChatMessageSurface sessionPath={SESSION} />);

    const transcript = screen.getByTestId('transcript');
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('模型现在过载了，稍后再试');
    expect(transcript.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('The model is currently overloaded')).not.toBeInTheDocument();
  });
});
