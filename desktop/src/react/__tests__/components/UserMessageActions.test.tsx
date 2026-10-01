// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessage } from '../../components/chat/UserMessage';
import { useStore } from '../../stores';

const retryMock = vi.fn(async (_sessionPath: string, _target: unknown, _options?: unknown) => true);
const forkMock = vi.fn(async (_sessionPath: string, _target: unknown) => ({
  sessionId: 'sess_fork',
  sessionPath: '/session/fork.jsonl',
  agentId: 'hana',
}));
const activateForkMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('../../stores/message-turn-actions', () => ({
  retrySessionTurn: (sessionPath: string, target: unknown, options?: unknown) =>
    retryMock(sessionPath, target, options),
  forkSessionTurn: (sessionPath: string, target: unknown) => forkMock(sessionPath, target),
  activateForkedSession: (forked: unknown) => activateForkMock(forked),
}));

describe('UserMessage Codex-style actions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      t: (key: string) => ({
        'common.me': '我',
        'common.copyText': '复制文本',
        'common.screenshot': '截图',
        'common.selectMessage': '选择消息',
        'common.selectAllMessages': '全选消息',
        'common.regenerate': '重新生成',
        'common.forkSession': '分支为新会话',
        'common.edit': '编辑',
        'common.cancel': '取消',
        'common.confirm': '确认',
        'chat.resend': '重发',
        'chat.sendFailed': '这条消息没发出去，可以编辑后重发',
      }[key] || key),
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    useStore.setState({
      userAvatarUrl: null,
      userName: '小黎',
      selectedIdsBySession: {},
      streamingSessions: [],
      chatSessions: {
        '/session/a.jsonl': {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'u1', role: 'user', text: '旧消息', textHtml: '<p>旧消息</p>' } },
          ],
        },
      },
    } as never);
  });

  it('shows retry, fork, and edit for every persisted user message', () => {
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>', timestamp: new Date(2026, 4, 7, 5, 42).getTime() };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage
      />,
    );

    expect(screen.getAllByTitle('复制文本')).toHaveLength(1);
    expect(screen.getByTitle('选择消息')).toBeInTheDocument();
    expect(screen.getByTitle('全选消息')).toBeInTheDocument();
    expect(screen.getByTitle('重新生成')).toBeInTheDocument();
    expect(screen.getByTitle('分支为新会话')).toBeInTheDocument();
    expect(screen.getByTitle('编辑')).toBeInTheDocument();
    expect(screen.getByText('05:42')).toBeInTheDocument();
  });

  it('orders the user footer as time, latest actions, copy, screenshot, select all, checkbox', () => {
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>', timestamp: new Date(2026, 4, 7, 5, 42).getTime() };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage
      />,
    );

    const footer = screen.getByTestId('user-message-footer-actions');
    expect(footer).toHaveAttribute('data-message-actions');
    const time = footer.querySelector('span')?.textContent?.trim();
    const titles = Array.from(footer.querySelectorAll('button')).map(button => button.getAttribute('title') || '');

    expect([time, ...titles]).toEqual([
      '05:42',
      '重新生成',
      '分支为新会话',
      '编辑',
      '复制文本',
      '截图',
      '全选消息',
      '选择消息',
    ]);
  });

  it('renders the message selection action in the user footer and toggles selection', () => {
    const message = { id: 'u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>', timestamp: new Date(2026, 4, 7, 5, 42).getTime() };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );

    const select = screen.getByTitle('选择消息');

    fireEvent.click(select);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['u1']);
    expect(select).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(select);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toBeUndefined();
  });

  it('keeps retry, fork, and edit available for older persisted user messages', () => {
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>', timestamp: new Date(2026, 4, 7, 5, 42).getTime() };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );

    expect(screen.getByText('05:42')).toBeInTheDocument();
    expect(screen.getByTitle('复制文本')).toBeInTheDocument();
    expect(screen.getByTitle('截图')).toBeInTheDocument();
    expect(screen.getByTitle('全选消息')).toBeInTheDocument();
    expect(screen.getByTitle('选择消息')).toBeInTheDocument();
    expect(screen.getByTitle('重新生成')).toBeInTheDocument();
    expect(screen.getByTitle('分支为新会话')).toBeInTheDocument();
    expect(screen.getByTitle('编辑')).toBeInTheDocument();
  });

  it('keeps retry and fork available for review user nodes without exposing text edit', () => {
    const message = {
      id: 'u-review',
      sourceEntryId: 'entry-review',
      role: 'user' as const,
      text: '审核结果',
      textHtml: '<p>审核结果</p>',
      agentReview: {
        status: 'completed' as const,
        requestId: 'review-1',
        reviewerSessionId: 'sess-reviewer',
        reviewerAgentId: 'critic',
        reviewerAgentName: 'Critic',
        text: '审核结果',
      },
    };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage
      />,
    );

    expect(screen.getByTitle('重新生成')).toBeInTheDocument();
    expect(screen.getByTitle('分支为新会话')).toBeInTheDocument();
    expect(screen.queryByTitle('编辑')).not.toBeInTheDocument();
  });

  it('forks a user node, activates the child, then retries the copied user turn there', async () => {
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>' };
    const onForkCreated = vi.fn(async () => undefined);

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
        onForkCreated={onForkCreated}
      />,
    );

    fireEvent.click(screen.getByTitle('分支为新会话'));

    await waitFor(() => expect(forkMock).toHaveBeenCalledWith(
      '/session/a.jsonl',
      { role: 'user', entryId: 'entry-u1' },
    ));
    expect(onForkCreated).toHaveBeenCalledWith({
      sessionId: 'sess_fork',
      sessionPath: '/session/fork.jsonl',
      agentId: 'hana',
    });
    expect(retryMock).toHaveBeenLastCalledWith(
      '/session/fork.jsonl',
      { role: 'user', entryId: 'entry-u1' },
      { message },
    );
  });

  it('uses the main-session activator when the transcript does not provide a surface override', async () => {
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>' };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );

    fireEvent.click(screen.getByTitle('分支为新会话'));

    await waitFor(() => expect(activateForkMock).toHaveBeenCalledWith({
      sessionId: 'sess_fork',
      sessionPath: '/session/fork.jsonl',
      agentId: 'hana',
    }));
  });

  it('submits inline edits through the branch-aware replay action', async () => {
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>' };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );

    fireEvent.click(screen.getByTitle('编辑'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '新消息' } });
    fireEvent.click(screen.getByTitle('确认'));

    expect(retryMock).toHaveBeenCalledWith(
      '/session/a.jsonl',
      { role: 'user', entryId: 'entry-u1' },
      { message, replacementText: '新消息' },
    );
  });

  it.each(['all', 'some'] as const)('sends an explicit attachment snapshot when a persisted edit removes %s chips', (mode) => {
    const message = {
      id: 'u1',
      sourceEntryId: 'entry-u1',
      role: 'user' as const,
      text: '旧消息',
      textHtml: '<p>旧消息</p>',
      attachments: [
        { fileId: 'sf-a', path: '/tmp/a.png', name: 'a.png', isDir: false },
        { fileId: 'sf-b', path: '/tmp/b.png', name: 'b.png', isDir: false },
      ],
    };
    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage
      />,
    );
    fireEvent.click(screen.getByTitle('编辑'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove b.png' }));
    if (mode === 'all') fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    fireEvent.click(screen.getByTitle('确认'));
    const expected = mode === 'all'
      ? []
      : [expect.objectContaining({ fileId: 'sf-a', path: '/tmp/a.png', name: 'a.png' })];
    expect(retryMock).toHaveBeenCalledWith(
      '/session/a.jsonl',
      { role: 'user', entryId: 'entry-u1' },
      {
        message: expect.objectContaining({ attachments: expected }),
        replacementText: '旧消息',
      },
    );
  });

  it('resends a failed message with the edited attachment list, including an empty one', () => {
    const message = {
      id: 'client-stuck',
      sourceEntryId: 'entry-stuck',
      role: 'user' as const,
      text: '封面',
      textHtml: '<p>封面</p>',
      sendStatus: 'failed' as const,
      attachments: [{ path: '/tmp/cover.png', name: 'cover.png', isDir: false }],
    };
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          hasMore: false,
          loadingMore: false,
          items: [{ type: 'message', data: message }],
        },
      },
    } as never);
    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );
    fireEvent.click(screen.getByTitle('编辑'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove cover.png' }));
    fireEvent.click(screen.getByTitle('确认'));
    expect(retryMock).not.toHaveBeenCalled();
    expect(useStore.getState().composerResendRequest).toEqual({
      sessionPath: '/session/a.jsonl',
      text: '封面',
      attachedFiles: [],
      autoSend: true,
    });
  });

  it('lets a failed optimistic message be resent from the composer', () => {
    const message = {
      id: 'client-stuck',
      role: 'user' as const,
      text: '封面',
      textHtml: '<p>封面</p>',
      sendStatus: 'failed' as const,
      attachments: [{ path: '/tmp/cover.png', name: 'cover.png', isDir: false }],
    };
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          hasMore: false,
          loadingMore: false,
          items: [{ type: 'message', data: message }],
        },
      },
    } as never);

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );

    expect(screen.getByText('这条消息没发出去，可以编辑后重发')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('重发'));

    expect(useStore.getState().composerResendRequest).toEqual({
      sessionPath: '/session/a.jsonl',
      text: '封面',
      attachedFiles: [expect.objectContaining({ path: '/tmp/cover.png', name: 'cover.png' })],
      autoSend: true,
    });
    expect(useStore.getState().chatSessions['/session/a.jsonl']?.items).toEqual([]);
  });

  it('includes newly pasted edit attachments in the retry envelope', async () => {
    const file = new File([new Uint8Array([1])], 'extra.png', { type: 'image/png' });
    Object.assign(window, {
      platform: {
        getFilePath: (candidate: File) => (candidate.name === 'extra.png' ? '/tmp/extra.png' : undefined),
      },
    });
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>' };

    render(
      <UserMessage
        viewerIdentity={{ name: '小黎', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage
      />,
    );

    fireEvent.click(screen.getByTitle('编辑'));
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        items: [{ type: 'image/png', getAsFile: () => file }],
      },
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '新消息' } });
    fireEvent.click(screen.getByTitle('确认'));

    expect(retryMock).toHaveBeenCalledWith(
      '/session/a.jsonl',
      { role: 'user', entryId: 'entry-u1' },
      {
        message: expect.objectContaining({
          attachments: [expect.objectContaining({ path: '/tmp/extra.png', name: 'extra.png', isDir: false })],
        }),
        replacementText: '新消息',
      },
    );
  });
});
