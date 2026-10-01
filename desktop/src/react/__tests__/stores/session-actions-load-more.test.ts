/**
 * loadMoreMessages / loadAllOlderMessages paging contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ChatItem = { type: 'message'; data: { id: string; role?: string; text?: string } };
type ChatSession = {
  items: ChatItem[];
  hasMore: boolean;
  loadingMore: boolean;
  oldestId?: string;
  revision?: string | null;
};

const mockState: Record<string, any> = {};

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
    setState: (patch: Record<string, any> | ((state: Record<string, any>) => Record<string, any>)) => {
      const next = typeof patch === 'function' ? patch(mockState) : patch;
      Object.assign(mockState, next);
    },
  },
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
  hanaUrl: (path: string) => path,
}));

vi.mock('../../utils/history-builder', () => ({
  buildItemsFromHistory: (data: { messages?: Array<Record<string, unknown>> }) => {
    if (!data || !Array.isArray(data.messages)) throw new Error('bad history');
    return data.messages.map((message, index) => ({
      type: 'message' as const,
      data: {
        id: String(message.id ?? `hist-${index}`),
        role: message.role || 'assistant',
        text: message.content || '',
      },
    }));
  },
}));

vi.mock('../../utils/todo-compat', () => ({
  migrateLegacyTodos: (value: { todos?: unknown[] }) => value.todos || [],
}));

vi.mock('../../utils/ui-helpers', () => ({
  loadModels: vi.fn(),
}));

vi.mock('../../stores/agent-actions', () => ({
  loadAvatars: vi.fn(),
  clearChat: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  activateWorkspaceDesk: vi.fn(),
}));

vi.mock('../../stores/stream-invalidator', () => ({
  snapshotStreamBuffer: vi.fn(() => null),
  invalidateStreamBuffer: vi.fn(),
  registerStreamBufferInvalidator: vi.fn(),
  registerStreamBufferSnapshot: vi.fn(),
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (value: string) => value,
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: () => null,
}));

vi.mock('../../services/stream-resume', () => ({
  requestStreamResume: vi.fn(),
}));

import { hanaFetch } from '../../hooks/use-hana-fetch';
import { sessionIdForPathFromLocatorState } from '../../stores/session-slice';
import { loadAllOlderMessages, loadMoreMessages } from '../../stores/session-actions';

const mockFetch = vi.mocked(hanaFetch);

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function message(id: string, text = id): ChatItem {
  return { type: 'message', data: { id, role: 'assistant', text } };
}

function seedSession(path: string, ids: string[], extra: Partial<ChatSession> = {}): void {
  const items = extra.items ?? ids.map((id) => message(id));
  (mockState.chatSessions as Record<string, ChatSession>)[path] = {
    hasMore: true,
    loadingMore: false,
    oldestId: ids[0],
    revision: null,
    ...extra,
    items,
  };
}

function chatBucket(path: string): { map: Record<string, ChatSession>; key: string } {
  const map = mockState.chatSessions as Record<string, ChatSession>;
  const sessionId = sessionIdForPathFromLocatorState(mockState, path);
  if (sessionId && Object.prototype.hasOwnProperty.call(map, sessionId)) return { map, key: sessionId };
  if (Object.prototype.hasOwnProperty.call(map, path)) return { map, key: path };
  return { map, key: path };
}

function idsOf(path: string): string[] {
  const { map, key } = chatBucket(path);
  return (map[key]?.items || []).map((item) => item.data.id);
}

function sessionOf(path: string): ChatSession | undefined {
  const { map, key } = chatBucket(path);
  return map[key];
}

function installStore(): void {
  mockState.setLoadingMore = vi.fn((path: string, loading: boolean) => {
    const { map, key } = chatBucket(path);
    const session = map[key];
    if (!session) return;
    map[key] = { ...session, loadingMore: loading };
  });
  mockState.prependItems = vi.fn((path: string, items: ChatItem[], hasMore: boolean) => {
    const { map, key } = chatBucket(path);
    const session = map[key];
    if (!session) return;
    const merged = [...items, ...session.items];
    map[key] = {
      ...session,
      items: merged,
      hasMore,
      loadingMore: false,
      oldestId: items.find((item) => item.type === 'message')?.data.id || session.oldestId,
    };
  });
  mockState.setSessionRegistryFiles = vi.fn((path: string, files: unknown[]) => {
    (mockState.sessionRegistryFilesByPath as Record<string, unknown>)[path] = files;
  });
  mockState.bumpLoadMessagesVersion = (path: string) => {
    const versions = mockState._loadMessagesVersion as Record<string, number>;
    const next = (versions[path] ?? 0) + 1;
    versions[path] = next;
    return next;
  };
}

describe('loadMoreMessages', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockState)) delete mockState[key];
    Object.assign(mockState, {
      currentSessionPath: '/focused.jsonl',
      currentSessionId: 'focused-id',
      sessionLocatorsById: { 'focused-id': { path: '/focused.jsonl' } },
      sessions: [
        { path: '/focused.jsonl', sessionId: 'focused-id' },
      ],
      chatSessions: {},
      sessionRegistryFilesByPath: {},
      _loadMessagesVersion: {},
      scrollPositions: { '/focused.jsonl': 12 },
      activeServerConnectionId: 'local',
    });
    installStore();
    mockFetch.mockReset();
  });

  it('releases its busy flag when a hydrate version advances but no replacement window commits', async () => {
    const target = '/hydrate-early-exit.jsonl';
    seedSession(target, ['50', '51']);
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
    const pending = loadMoreMessages(target);
    expect(sessionOf(target)?.loadingMore).toBe(true);
    mockState.bumpLoadMessagesVersion(target);
    resolveResponse(jsonResponse({ messages: [{ id: '40', role: 'assistant', content: 'older' }], hasMore: true }));
    expect((await pending).status).toBe('stale');
    expect(sessionOf(target)?.loadingMore).toBe(false);
    expect(idsOf(target)).toEqual(['50', '51']);
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [{ id: '40', role: 'assistant', content: 'older' }], hasMore: true }));
    expect((await loadMoreMessages(target)).status).toBe('loaded');
    expect(idsOf(target)).toEqual(['40', '50', '51']);
  });

  it('prepends an older page onto the requested session, not the focused one', async () => {
    const target = '/background.jsonl';
    mockState.sessions.push({ path: target, sessionId: 'background-id' });
    seedSession(target, ['50', '51']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [
        { id: '40', role: 'assistant', content: 'older' },
        { id: '41', role: 'assistant', content: 'older-2' },
      ],
      hasMore: true,
      sessionFiles: [{ fileId: 'file-a' }],
    }));

    const result = await loadMoreMessages(target, { limit: 20 });

    expect(result).toMatchObject({
      status: 'loaded',
      progressed: true,
      cursor: '50',
      nextCursor: '40',
      hasMore: true,
      added: 2,
    });
    expect(idsOf(target)).toEqual(['40', '41', '50', '51']);
    expect(mockState.currentSessionPath).toBe('/focused.jsonl');
    expect(mockState.scrollPositions['/focused.jsonl']).toBe(12);
    expect(mockState.sessionRegistryFilesByPath[target]).toEqual([{ fileId: 'file-a' }]);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('path=' + encodeURIComponent(target));
    expect(url).toContain('sessionId=background-id');
    expect(url).not.toContain('sessionId=focused-id');
    expect(url).toContain('before=50');
    expect(url).toContain('limit=20');
  });

  it('dedupes message ids already on screen', async () => {
    const target = '/dedup.jsonl';
    seedSession(target, ['40', '41']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [
        { id: '38', role: 'assistant', content: 'new' },
        { id: '39', role: 'assistant', content: 'new-2' },
        { id: '40', role: 'assistant', content: 'dup' },
        { id: '38', role: 'assistant', content: 'dup-inside-page' },
      ],
      hasMore: true,
    }));

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'loaded', progressed: true, added: 2, nextCursor: '38' });
    expect(idsOf(target)).toEqual(['38', '39', '40', '41']);
  });

  it('latches a duplicate page and does not forge hasMore=false', async () => {
    const target = '/stall-dup.jsonl';
    seedSession(target, ['10', '11']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [
        { id: '10', role: 'assistant', content: 'same' },
        { id: '11', role: 'assistant', content: 'same-2' },
      ],
      hasMore: true,
    }));

    const first = await loadMoreMessages(target);
    const second = await loadMoreMessages(target);

    expect(first).toMatchObject({ status: 'stalled', progressed: false, reason: 'duplicate-page', hasMore: true });
    expect(second).toMatchObject({ status: 'stalled', progressed: false, reason: 'cursor-latched' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(true);
    expect(idsOf(target)).toEqual(['10', '11']);
  });

  it('retry asks the same cursor once more, then latches again', async () => {
    const target = '/retry.jsonl';
    seedSession(target, ['10']);
    mockFetch.mockResolvedValue(jsonResponse({ messages: [], hasMore: true }));

    expect((await loadMoreMessages(target)).status).toBe('stalled');
    expect((await loadMoreMessages(target, { retry: true })).reason).toBe('empty-page');
    expect((await loadMoreMessages(target)).reason).toBe('cursor-latched');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(true);
  });

  it('an empty last page is exhausted', async () => {
    const target = '/empty-tail.jsonl';
    seedSession(target, ['4']);
    mockFetch.mockResolvedValue(jsonResponse({ messages: [], hasMore: false }));

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'exhausted', progressed: false, hasMore: false, added: 0 });
    expect(idsOf(target)).toEqual(['4']);
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(false);
  });

  it('does not fetch when the session is already exhausted', async () => {
    const target = '/done.jsonl';
    seedSession(target, ['1'], { hasMore: false });

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'exhausted', progressed: false, hasMore: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps hasMore when HTTP, JSON, or payload validation fails', async () => {
    const target = '/fail.jsonl';
    seedSession(target, ['8']);
    mockFetch.mockRejectedValueOnce(new Error('hanaFetch /api/sessions/messages: 500 Internal Server Error'));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Response);
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'nope' }));

    const httpFailed = await loadMoreMessages(target);
    const badJson = await loadMoreMessages(target);
    const badPayload = await loadMoreMessages(target);

    expect(httpFailed).toMatchObject({ status: 'failed', progressed: false, reason: 'network', hasMore: true });
    expect(badJson).toMatchObject({ status: 'failed', reason: 'invalid-json', hasMore: true });
    expect(badPayload).toMatchObject({ status: 'failed', reason: 'invalid-payload', hasMore: true });
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(true);
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].loadingMore).toBe(false);
    expect(idsOf(target)).toEqual(['8']);
  });

  it('treats a non-2xx body as failed', async () => {
    const target = '/http.jsonl';
    seedSession(target, ['8']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [{ id: '1', role: 'assistant', content: 'x' }],
      hasMore: false,
    }, false, 503));

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'failed', reason: 'http-503', hasMore: true });
    expect(idsOf(target)).toEqual(['8']);
  });

  it('does not prepend a numerically newer page', async () => {
    const target = '/newer.jsonl';
    seedSession(target, ['10', '11']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [
        { id: '12', role: 'assistant', content: 'newer' },
        { id: '13', role: 'assistant', content: 'newer-2' },
      ],
      hasMore: true,
    }));

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'stalled', progressed: false, reason: 'cursor-unmoved' });
    expect(idsOf(target)).toEqual(['10', '11']);
    expect((await loadMoreMessages(target)).reason).toBe('cursor-latched');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous hasMore when the server omits it', async () => {
    const target = '/omit-has-more.jsonl';
    seedSession(target, ['50', '51']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [
        { id: '48', role: 'assistant', content: 'older' },
        { id: '49', role: 'assistant', content: 'older-2' },
        { id: '50', role: 'assistant', content: 'dup' },
      ],
    }));

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'loaded', progressed: true, hasMore: true, added: 2 });
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(true);
  });

  it('keeps live registry upserts and does not touch a loadMessages file flight', async () => {
    const target = '/files.jsonl';
    seedSession(target, ['50']);
    const fileA = { fileId: 'a', label: 'a' };
    const fileB = { fileId: 'b', label: 'b' };
    mockState.sessionRegistryFilesByPath[target] = [fileA, fileB];
    mockFetch.mockImplementation(async () => {
      mockState.sessionRegistryFilesByPath[target] = [
        { fileId: 'a', label: 'a-live' },
        fileB,
        { fileId: 'c', label: 'c-live' },
      ];
      return jsonResponse({
        messages: [{ id: '49', role: 'assistant', content: 'older' }],
        hasMore: true,
        sessionFiles: [
          { fileId: 'a', label: 'a-stale' },
          { fileId: 'b', label: 'b-server' },
        ],
      });
    });

    await loadMoreMessages(target);

    expect(mockState.setSessionRegistryFiles).toHaveBeenCalledWith(target, [
      { fileId: 'a', label: 'a-live' },
      { fileId: 'b', label: 'b-server' },
      { fileId: 'c', label: 'c-live' },
    ]);

    const resetTarget = '/files-reset.jsonl';
    seedSession(resetTarget, ['50']);
    const flight = { version: 2, resetSeen: true, upserts: [{ fileId: 'kept' }] };
    mockState._sessionFilesFlightByPath = { [resetTarget]: flight };
    mockState.sessionRegistryFilesByPath[resetTarget] = [{ fileId: 'kept', label: 'branch' }];
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [{ id: '49', role: 'assistant', content: 'older' }],
      hasMore: true,
      sessionFiles: [{ fileId: 'server-only', label: 'page' }],
    }));

    await loadMoreMessages(resetTarget);

    expect(mockState.setSessionRegistryFiles).not.toHaveBeenCalledWith(
      resetTarget,
      expect.anything(),
    );
    expect(mockState._sessionFilesFlightByPath[resetTarget]).toBe(flight);
    expect(mockState.sessionRegistryFilesByPath[resetTarget]).toEqual([{ fileId: 'kept', label: 'branch' }]);
  });

  it('derives the next before from message ids when the server has no cursor field', async () => {
    const target = '/legacy.jsonl';
    seedSession(target, ['50']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [{ id: '49', role: 'user', content: 'hi' }],
      blocks: [],
      hasMore: false,
    }));

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'loaded', progressed: true, nextCursor: '49', hasMore: false });
    expect(String(mockFetch.mock.calls[0][0])).toContain('before=50');
    expect(String(mockFetch.mock.calls[0][0])).not.toContain('nextBefore');
  });

  it('stops when the server cursor does not move, even if message ids look older', async () => {
    const target = '/server-cursor.jsonl';
    seedSession(target, ['50']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [{ id: '40', role: 'assistant', content: 'looks older' }],
      hasMore: true,
      nextBefore: '50',
    }));

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'stalled', reason: 'cursor-unmoved', hasMore: true });
    expect(idsOf(target)).toEqual(['50']);
  });

  it('dedupes concurrent calls onto one request', async () => {
    const target = '/busy.jsonl';
    seedSession(target, ['20']);
    let release: (value: Response) => void = () => {};
    mockFetch.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));

    const first = loadMoreMessages(target);
    const second = await loadMoreMessages(target);
    expect(second).toMatchObject({ status: 'busy', progressed: false, reason: 'in-flight' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    release(jsonResponse({
      messages: [{ id: '19', role: 'assistant', content: 'older' }],
      hasMore: true,
    }));
    await expect(first).resolves.toMatchObject({ status: 'loaded', nextCursor: '19' });
  });

  it('keeps a live tail appended while the older page is in flight', async () => {
    const target = '/live.jsonl';
    seedSession(target, ['50', '51']);
    mockFetch.mockImplementation(async () => {
      const chat = mockState.chatSessions as Record<string, ChatSession>;
      const session = chat[target];
      chat[target] = {
        ...session,
        items: [...session.items, message('52', 'live')],
      };
      return jsonResponse({
        messages: [{ id: '49', role: 'assistant', content: 'older' }],
        hasMore: true,
      });
    });

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'loaded', progressed: true, nextCursor: '49' });
    expect(idsOf(target)).toEqual(['49', '50', '51', '52']);
  });

  it('drops a stale page after identity changes and leaves the next flight loading', async () => {
    const target = '/replace.jsonl';
    mockState.sessions.push({ path: target, sessionId: 'sid-1' });
    seedSession(target, ['50']);
    let second: Promise<unknown> = Promise.resolve();
    let releaseSecond: (value: Response) => void = () => {};
    mockFetch.mockImplementation(() => {
      const calls = mockFetch.mock.calls.length;
      if (calls === 1) {
        mockState.sessions = [
          { path: '/focused.jsonl', sessionId: 'focused-id' },
          { path: target, sessionId: 'sid-2' },
        ];
        second = loadMoreMessages(target);
        return Promise.resolve(jsonResponse({
          messages: [{ id: '1', role: 'assistant', content: 'stale page' }],
          hasMore: true,
        }));
      }
      return new Promise((resolve) => {
        releaseSecond = resolve;
      });
    });

    const first = await loadMoreMessages(target);
    expect(first).toMatchObject({ status: 'stale', progressed: false, reason: 'session-identity-changed' });
    expect(idsOf(target)).toEqual(['50']);
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].loadingMore).toBe(true);

    releaseSecond(jsonResponse({
      messages: [{ id: '49', role: 'assistant', content: 'kept' }],
      hasMore: true,
    }));
    await expect(second).resolves.toMatchObject({ status: 'loaded', nextCursor: '49', added: 1 });
    expect(idsOf(target)).toEqual(['49', '50']);
  });

  it('does not mix an older page into a replaced window', async () => {
    const target = '/init.jsonl';
    seedSession(target, ['50', '51'], { revision: 'rev-a' });
    mockFetch.mockImplementation(async () => {
      mockState.bumpLoadMessagesVersion(target);
      (mockState.chatSessions as Record<string, ChatSession>)[target] = {
        items: [message('7')],
        hasMore: true,
        loadingMore: true,
        oldestId: '7',
        revision: 'rev-b',
      };
      return jsonResponse({
        messages: [{ id: '40', role: 'assistant', content: 'old window' }],
        hasMore: true,
        sessionFiles: [{ fileId: 'stale-file' }],
      });
    });

    const result = await loadMoreMessages(target);

    expect(result).toMatchObject({ status: 'stale', reason: 'window-replaced' });
    expect(idsOf(target)).toEqual(['7']);
    expect(mockState.sessionRegistryFilesByPath[target]).toBeUndefined();
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].loadingMore).toBe(true);
  });

  it('drops in-flight pages when the session disappears or the connection changes', async () => {
    const removed = '/removed.jsonl';
    const switched = '/switched.jsonl';
    seedSession(removed, ['3']);
    seedSession(switched, ['3']);
    mockFetch.mockImplementationOnce(async () => {
      delete (mockState.chatSessions as Record<string, ChatSession>)[removed];
      return jsonResponse({
        messages: [{ id: '1', role: 'assistant', content: 'gone' }],
        hasMore: true,
      });
    });
    mockFetch.mockImplementationOnce(async () => {
      mockState.activeServerConnectionId = 'remote';
      return jsonResponse({
        messages: [{ id: '1', role: 'assistant', content: 'other server' }],
        hasMore: true,
      });
    });

    const removedResult = await loadMoreMessages(removed);
    const switchedResult = await loadMoreMessages(switched);

    expect(removedResult).toMatchObject({ status: 'stale', reason: 'session-removed', progressed: false });
    expect(switchedResult).toMatchObject({ status: 'stale', reason: 'connection-changed', progressed: false });
    expect(idsOf(switched)).toEqual(['3']);
    expect((mockState.chatSessions as Record<string, ChatSession>)[switched].hasMore).toBe(true);
  });

  it('lets the new connection page the same session while the old flight is still out', async () => {
    const target = '/same.jsonl';
    mockState.sessions.push({ path: target, sessionId: 'same-sid' });
    seedSession(target, ['50', '51']);
    let releaseOld: (value: Response) => void = () => {};
    let releaseNew: (value: Response) => void = () => {};
    mockFetch.mockImplementation(() => {
      const call = mockFetch.mock.calls.length;
      if (call === 1) {
        return new Promise((resolve) => {
          releaseOld = resolve;
        });
      }
      return new Promise((resolve) => {
        releaseNew = resolve;
      });
    });

    const oldFlight = loadMoreMessages(target);
    await Promise.resolve();
    mockState.activeServerConnectionId = 'remote';
    const newFlight = loadMoreMessages(target);
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    releaseOld(jsonResponse({
      messages: [{ id: '1', role: 'assistant', content: 'old connection' }],
      hasMore: true,
    }));
    await expect(oldFlight).resolves.toMatchObject({
      status: 'stale',
      progressed: false,
      reason: 'connection-changed',
    });
    expect(sessionOf(target)?.loadingMore).toBe(true);
    expect(idsOf(target)).toEqual(['50', '51']);

    releaseNew(jsonResponse({
      messages: [{ id: '49', role: 'assistant', content: 'new connection' }],
      hasMore: true,
    }));
    await expect(newFlight).resolves.toMatchObject({
      status: 'loaded',
      progressed: true,
      nextCursor: '49',
      added: 1,
    });
    expect(idsOf(target)).toEqual(['49', '50', '51']);
    expect(sessionOf(target)?.loadingMore).toBe(false);
  });

  it('shares one flight across path aliases of the same session', async () => {
    const session = {
      items: [message('50')],
      hasMore: true,
      loadingMore: false,
      oldestId: '50',
      revision: null,
    };
    (mockState.chatSessions as Record<string, ChatSession>).same = session;
    mockState.sessions.push(
      { path: '/alias-a.jsonl', sessionId: 'same' },
      { path: '/alias-b.jsonl', sessionId: 'same' },
    );
    let release: (value: Response) => void = () => {};
    mockFetch.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));

    const first = loadMoreMessages('/alias-a.jsonl');
    const second = await loadMoreMessages('/alias-b.jsonl');

    expect(second).toMatchObject({ status: 'busy', reason: 'in-flight' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    release(jsonResponse({
      messages: [{ id: '49', role: 'assistant', content: 'older' }],
      hasMore: false,
    }));
    await expect(first).resolves.toMatchObject({ status: 'loaded', nextCursor: '49' });
    expect(idsOf('/alias-b.jsonl')).toEqual(['49', '50']);
  });

  it('reports a missing session and caps the requested limit', async () => {
    expect(await loadMoreMessages('/missing.jsonl')).toMatchObject({ status: 'failed', reason: 'missing-session' });
    mockState.currentSessionPath = '';
    expect(await loadMoreMessages()).toMatchObject({ status: 'failed', reason: 'no-path' });
    const target = '/limit.jsonl';
    seedSession(target, ['80']);
    mockFetch.mockResolvedValue(jsonResponse({
      messages: [{ id: '79', role: 'assistant', content: 'older' }],
      hasMore: true,
    }));

    await loadMoreMessages(target, { limit: 500 });

    expect(String(mockFetch.mock.calls[0][0])).toContain('limit=200');
  });
});

describe('loadAllOlderMessages', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockState)) delete mockState[key];
    Object.assign(mockState, {
      currentSessionPath: '/focused.jsonl',
      currentSessionId: null,
      sessionLocatorsById: {},
      sessions: [],
      chatSessions: {},
      sessionRegistryFilesByPath: {},
      _loadMessagesVersion: {},
      scrollPositions: {},
      activeServerConnectionId: null,
    });
    installStore();
    mockFetch.mockReset();
  });

  it('walks older pages for the requested session without moving focus', async () => {
    const target = '/all.jsonl';
    seedSession(target, ['30']);
    mockFetch.mockImplementation(async (url: string) => {
      const before = Number(new URL(String(url), 'http://local').searchParams.get('before'));
      if (before <= 10) {
        return jsonResponse({
          messages: [{ id: String(before - 1), role: 'assistant', content: 'last' }],
          hasMore: false,
        });
      }
      return jsonResponse({
        messages: [{ id: String(before - 10), role: 'assistant', content: 'page' }],
        hasMore: true,
      });
    });

    const done = await loadAllOlderMessages(target);

    expect(done).toBe(true);
    expect(mockState.currentSessionPath).toBe('/focused.jsonl');
    expect(idsOf(target)[0]).toBe('9');
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(false);
    expect(String(mockFetch.mock.calls[0][0])).toContain('limit=200');
  });

  it('stops on the first non-advancing cursor', async () => {
    const target = '/all-stall.jsonl';
    seedSession(target, ['15']);
    mockFetch.mockResolvedValue(jsonResponse({ messages: [], hasMore: true }));

    const done = await loadAllOlderMessages(target);

    expect(done).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(true);
  });

  it('waits out an owned flight up to the given budget, then stops', async () => {
    const target = '/all-busy.jsonl';
    seedSession(target, ['15']);
    let release: (value: Response) => void = () => {};
    mockFetch.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));
    const pending = loadMoreMessages(target);

    const started = Date.now();
    const done = await loadAllOlderMessages(target, { flightWaitMs: 500 });
    const elapsed = Date.now() - started;
    expect(done).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1500);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    release(jsonResponse({
      messages: [{ id: '14', role: 'assistant', content: 'later' }],
      hasMore: false,
    }));
    await pending;
  });

  it('continues after the owned flight actually finishes', async () => {
    const target = '/all-join.jsonl';
    seedSession(target, ['20']);
    let release: (value: Response) => void = () => {};
    mockFetch.mockImplementation(() => {
      if (mockFetch.mock.calls.length === 1) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(jsonResponse({
        messages: [{ id: '9', role: 'assistant', content: 'rest' }],
        hasMore: false,
      }));
    });
    const pending = loadMoreMessages(target);
    const done = loadAllOlderMessages(target, { flightWaitMs: 2000 });
    await Promise.resolve();
    release(jsonResponse({
      messages: [{ id: '10', role: 'assistant', content: 'first' }],
      hasMore: true,
    }));

    await expect(done).resolves.toBe(true);
    await pending;
    expect(idsOf(target)[0]).toBe('9');
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('leaves an ownerless loading flag immediately', async () => {
    const target = '/all-orphan.jsonl';
    seedSession(target, ['15'], { loadingMore: true });

    const started = Date.now();
    const done = await loadAllOlderMessages(target, { flightWaitMs: 5000 });

    expect(done).toBe(false);
    expect(Date.now() - started).toBeLessThan(80);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stops when the caller aborts or shouldContinue flips', async () => {
    const target = '/all-cancel.jsonl';
    seedSession(target, ['40']);
    let release: (value: Response) => void = () => {};
    mockFetch.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));
    const pending = loadMoreMessages(target);
    const controller = new AbortController();
    const done = loadAllOlderMessages(target, { signal: controller.signal, flightWaitMs: 8000 });
    controller.abort();

    await expect(done).resolves.toBe(false);
    release(jsonResponse({
      messages: [{ id: '30', role: 'assistant', content: 'late' }],
      hasMore: true,
    }));
    await pending;

    const stepped = '/all-stop.jsonl';
    seedSession(stepped, ['30']);
    let allow = true;
    mockFetch.mockClear();
    mockFetch.mockImplementation(async (url: string) => {
      const before = Number(new URL(String(url), 'http://local').searchParams.get('before'));
      allow = false;
      return jsonResponse({
        messages: [{ id: String(before - 10), role: 'assistant', content: 'page' }],
        hasMore: true,
      });
    });

    const stopped = await loadAllOlderMessages(stepped, { shouldContinue: () => allow });
    expect(stopped).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns false after the page cap', async () => {
    const target = '/all-cap.jsonl';
    seedSession(target, ['5000']);
    mockFetch.mockImplementation(async (url: string) => {
      const before = Number(new URL(String(url), 'http://local').searchParams.get('before'));
      return jsonResponse({
        messages: [{ id: String(before - 1), role: 'assistant', content: 'step' }],
        hasMore: true,
      });
    });

    const done = await loadAllOlderMessages(target);

    expect(done).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(50);
    expect((mockState.chatSessions as Record<string, ChatSession>)[target].hasMore).toBe(true);
  });
});
