/**
 * session-actions.ts — Session 生命周期操作（纯逻辑 + API）
 *
 * 从 sidebar-shim.ts 迁移。所有函数直接操作 Zustand store，
 * 不依赖 ctx 注入，不持有闭包状态（除 _switchVersion 防竞争）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- store partial patch + API 响应 JSON */

import { useStore } from './index';
import { sessionIdForPathFromLocatorState, sessionScopedKey, sessionScopedListIncludes, sessionScopedValue } from './session-slice';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { hydrateInputDrafts } from './input-draft-persistence';
import { HOME_DRAFT_KEY } from '../../../../shared/input-drafts.ts';
import { buildItemsFromHistory } from '../utils/history-builder';
import { migrateLegacyTodos } from '../utils/todo-compat';
import { clearChat as clearChatAction } from './agent-actions';
import { activateWorkspaceDesk } from './desk-actions';
import { loadModels } from '../utils/ui-helpers';
import { browserStateForPath, setBrowserStateForPath } from './browser-slice';
import { computerOverlayForSession } from './computer-overlay-slice';
import { snapshotStreamBuffer, type StreamBufferSnapshot } from './stream-invalidator';
import { errorWithCode, presentError, presentErrorWithLabel } from '../errors/error-presenter';
import { normalizeSessionRouteError } from '../../../../shared/error-user-messages.ts';
import { renderMarkdown } from '../utils/markdown';
import type { ChatMessage, ContentBlock, SessionMessages } from './chat-types';
import { readMessageLiveVersion } from './message-live-version';
import type { SessionMetaRecoveryStatus, SessionPermissionMode } from '../types';
import { findPrimaryAgent, resolveAgentWorkspace } from '../utils/agent-workspace';

// ── 防竞争计数器 ──

let _switchVersion = 0;
let _switchAbortController: AbortController | null = null;
let _pendingDraftSequence = 0;

export interface SessionRef {
  sessionId: string;
  sessionPath: string;
  agentId: string;
}

function nextPendingDraftId(): string {
  _pendingDraftSequence += 1;
  return `pending-${Date.now().toString(36)}-${_pendingDraftSequence.toString(36)}`;
}

/**
 * pending 新会话身份补丁：任何把 store 切入 "welcome / 待建会话" 态的入口都必须
 * 展开这个补丁，而不是裸设 `pendingNewSession: true`。currentPendingSessionDraft()
 * 要求 pendingDraftId 非空才认这是一个有效的待建草稿；裸设会让身份残缺，
 * submitEditorMessage 的 ensureSession 门槛就此失效，发送静默无响应（#2101）。
 */
export function pendingNewSessionIdentityPatch(): { pendingNewSession: true; pendingDraftId: string } {
  return { pendingNewSession: true, pendingDraftId: nextPendingDraftId() };
}

function invalidateSessionSwitches(): void {
  _switchVersion += 1;
  _switchAbortController?.abort();
  _switchAbortController = null;
  useStore.setState({ pendingSessionSwitchPath: null });
}

function isCurrentSwitch(version: number, path: string): boolean {
  const state = useStore.getState();
  return version === _switchVersion && state.pendingSessionSwitchPath === path;
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mergeSessionLocators(current: Record<string, { path: string | null }> = {}, sessions: any[] = []) {
  const next = { ...current };
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = normalizeSessionId(session?.sessionId);
    if (!sessionId) continue;
    next[sessionId] = { path: typeof session.path === 'string' ? session.path : null };
  }
  return next;
}

function sessionIdForPathFromState(state: Record<string, any>, path: string | null): string | null {
  if (!path) return null;
  const session = (state.sessions || []).find((item: any) => item?.path === path);
  return normalizeSessionId(session?.sessionId);
}

function frozenSessionRefFromState(state: Record<string, any>): Readonly<SessionRef> | null {
  const sessionPath = typeof state.currentSessionPath === 'string' && state.currentSessionPath.trim()
    ? state.currentSessionPath
    : null;
  if (!sessionPath) return null;
  const projection = sessionByIdentityOrPath(
    state,
    normalizeSessionId(state.currentSessionId),
    sessionPath,
  );
  const sessionId = normalizeSessionId(state.currentSessionId)
    || normalizeSessionId(projection?.sessionId)
    || sessionIdForPathFromState(state, sessionPath);
  const agentId = normalizeSessionId(projection?.agentId) || normalizeSessionId(state.currentAgentId);
  if (!sessionId || !agentId) return null;
  return Object.freeze({ sessionId, sessionPath, agentId });
}

function frozenSessionRefFromCreateResponse(data: any): Readonly<SessionRef> | null {
  const sessionId = normalizeSessionId(data?.sessionId);
  const sessionPath = typeof data?.path === 'string' && data.path.trim() ? data.path : null;
  const agentId = normalizeSessionId(data?.agentId);
  if (!sessionId || !sessionPath || !agentId) return null;
  return Object.freeze({ sessionId, sessionPath, agentId });
}

function sessionByIdentityOrPath(state: Record<string, any>, sessionId: string | null, sessionPath: string | null): any | null {
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  if (sessionId) {
    const byId = sessions.find((item: any) => normalizeSessionId(item?.sessionId) === sessionId);
    if (byId) return byId;
  }
  if (sessionPath) {
    return sessions.find((item: any) => item?.path === sessionPath) || null;
  }
  return null;
}

function currentSessionIdentityPatch(state: Record<string, any>, path: string | null, sessionId: unknown) {
  const normalizedSessionId = normalizeSessionId(sessionId) || sessionIdForPathFromState(state, path);
  return {
    currentSessionPath: path,
    currentSessionId: normalizedSessionId,
    ...(normalizedSessionId ? {
      sessionLocatorsById: {
        ...(state.sessionLocatorsById || {}),
        [normalizedSessionId]: { path },
      },
    } : {}),
  };
}

function sessionMessagesUrl(path: string, extra: Record<string, string> = {}): string {
  const state = useStore.getState() as Record<string, any>;
  const params = new URLSearchParams();
  params.set('path', path);
  const sessionId = sessionIdForPathFromState(state, path);
  if (sessionId) params.set('sessionId', sessionId);
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, value);
  }
  return `/api/sessions/messages?${params.toString()}`;
}

function putSessionScopedStateValue(
  state: Record<string, any>,
  map: Record<string, any> = {},
  sessionPath: string,
  value: any,
): Record<string, any> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map, [key]: value };
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

function deleteSessionScopedStateValue(
  state: Record<string, any>,
  map: Record<string, any> = {},
  sessionPath: string,
): Record<string, any> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map };
  delete next[key];
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (
    (err as { name?: string }).name === 'AbortError' ||
    (err as { message?: string }).message === 'This operation was aborted'
  );
}

function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { hana?: unknown }).hana;
}

function shouldRestoreInputFocus(path: string | null): boolean {
  const state = useStore.getState() as Record<string, any>;
  if (!isDesktopShell()) return false;
  if (state.currentTab !== 'chat') return false;
  if (path) {
    if (state.currentSessionPath !== path) return false;
  } else if (state.pendingNewSession !== true || state.currentSessionPath !== null || state.pendingSessionSwitchPath) {
    return false;
  }
  if (state.settingsModal?.open || state.mediaViewer || state.skillViewerData || state.channelCreateOverlayVisible) return false;
  if (path && computerOverlayForSession(state as any, path)) return false;
  return true;
}

function requestChatInputFocus(path: string | null): void {
  if (shouldRestoreInputFocus(path)) useStore.getState().requestInputFocus?.();
}

function isPendingNewSessionDraftView(): boolean {
  const state = useStore.getState() as Record<string, any>;
  return state.pendingNewSession === true
    && state.currentSessionPath === null
    && !state.pendingSessionSwitchPath;
}

const SESSION_PERMISSION_MODES = new Set(['auto', 'operate', 'ask', 'read_only']);

function normalizeSessionPermissionMode(mode: unknown): SessionPermissionMode {
  return typeof mode === 'string' && SESSION_PERMISSION_MODES.has(mode)
    ? mode as SessionPermissionMode
    : 'ask';
}

function emitSessionPermissionMode(mode: unknown): SessionPermissionMode {
  const normalized = normalizeSessionPermissionMode(mode);
  useStore.getState().setSessionPermissionMode?.(normalized);
  window.dispatchEvent(new CustomEvent('hana-plan-mode', {
    detail: { enabled: normalized === 'read_only', mode: normalized },
  }));
  return normalized;
}

function findSessionProjection(path: string): any | null {
  return useStore.getState().sessions.find((session: any) => session.path === path) || null;
}

function isDeletedAgentSession(path: string): boolean {
  return findSessionProjection(path)?.agentDeleted === true;
}

function filterSessionScopedStateList(state: Record<string, any>, list: string[] | undefined, path: string): string[] {
  const current = Array.isArray(list) ? list : [];
  const key = sessionScopedKey(state, path) || path;
  return current.filter((item) => item !== key && item !== path);
}

function putSessionScopedStateListValue(state: Record<string, any>, list: string[] | undefined, path: string): string[] {
  const key = sessionScopedKey(state, path) || path;
  return [...filterSessionScopedStateList(state, list, path), key];
}

function reconcileStreamingSessionsForPath(
  state: Record<string, any>,
  streamingSessions: string[] | undefined,
  path: string,
  isStreaming: boolean,
): string[] {
  const current = Array.isArray(streamingSessions) ? streamingSessions : [];
  if (isStreaming) {
    return putSessionScopedStateListValue(state, current, path);
  }
  return filterSessionScopedStateList(state, current, path);
}

async function requestActiveSessionStreamResume(path: string, isStreaming: boolean): Promise<void> {
  if (!isStreaming) return;
  try {
    const { requestStreamResume } = await import('../services/stream-resume');
    requestStreamResume(path);
  } catch (err) {
    console.warn('[session] stream resume request skipped after switch:', err);
  }
}

async function resetDeskForSessionWorkspace({
  cwd,
  workspaceMountId,
  workspaceLabel,
}: {
  cwd?: string | null;
  workspaceMountId?: string | null;
  workspaceLabel?: string | null;
}): Promise<void> {
  // Session 切换后的 cwd 以服务端显式返回值为准；右侧 desk 视图归 workspace/CWD 所有。
  // 切到同一 workspace 时保留当前子目录；切到不同 workspace 时恢复该 workspace 的上次子目录。
  await activateWorkspaceDesk(cwd || null, {
    mountId: workspaceMountId || null,
    label: workspaceLabel || null,
  });
}

function clearSessionRuntimeCaches(path: string): void {
  useStore.getState().clearSession?.(path);
  useStore.setState((s: Record<string, any>) => {
    const attachedFilesBySession = deleteSessionScopedStateValue(s, s.attachedFilesBySession || {}, path);
    const sessionRegistryFilesByPath = deleteSessionScopedStateValue(s, s.sessionRegistryFilesByPath || {}, path);
    const drafts = deleteSessionScopedStateValue(s, s.drafts || {}, path);
    const draftDocs = deleteSessionScopedStateValue(s, s.draftDocs || {}, path);
    const activeSessionStreams = deleteSessionScopedStateValue(s, s.activeSessionStreams || {}, path);
    const computerOverlayBySession = deleteSessionScopedStateValue(s, s.computerOverlayBySession || {}, path);
    const scrollPositions = deleteSessionScopedStateValue(s, s.scrollPositions || {}, path);
    const sessionStreams = deleteSessionScopedStateValue(s, s.sessionStreams || {}, path);
    const browserBySession = deleteSessionScopedStateValue(s, s.browserBySession || {}, path);
    const todosBySession = deleteSessionScopedStateValue(s, s.todosBySession || {}, path);
    const todosLiveVersionBySession = deleteSessionScopedStateValue(s, s.todosLiveVersionBySession || {}, path);
    const sessionAuthorizedFoldersByPath = deleteSessionScopedStateValue(s, s.sessionAuthorizedFoldersByPath || {}, path);
    let inlineErrors = s.inlineErrors;
    if (inlineErrors) {
      inlineErrors = deleteSessionScopedStateValue(s, inlineErrors || {}, path);
      const key = sessionScopedKey(s, path) || path;
      inlineErrors = { ...inlineErrors, [key]: null, [path]: null };
    }
    return {
      attachedFilesBySession,
      sessionRegistryFilesByPath,
      drafts,
      draftDocs,
      sessionStreams,
      activeSessionStreams,
      browserBySession,
      computerOverlayBySession,
      scrollPositions,
      streamingSessions: filterSessionScopedStateList(s, s.streamingSessions || [], path),
      unreadOutputSessionPaths: filterSessionScopedStateList(s, s.unreadOutputSessionPaths || [], path),
      todosBySession,
      todosLiveVersionBySession,
      sessionAuthorizedFoldersByPath,
      capabilityRefreshingSessions: filterSessionScopedStateList(s, s.capabilityRefreshingSessions || [], path),
      inlineErrors,
    };
  });
}

// ══════════════════════════════════════════════════════
// 消息加载（从 app-messages-shim 迁移）
// ══════════════════════════════════════════════════════

export async function loadMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  const messageLiveVersionBefore = readMessageLiveVersion(targetPath);
  // 捕获 hydrate 前的 live 版本：若 fetch 期间有 tool_end 更新 todos，
  // 后面就跳过 hydrate 写入，避免旧快照覆盖刚收到的实时状态。
  const todosLiveVersionBefore =
    sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().todosLiveVersionBySession, targetPath) ?? 0;
  // messages 维度的竞态护栏：rapid switch 或并发 load 时，只有最新一次调用
  // 的响应允许 apply initSession，stale 响应直接丢弃。
  const myVersion = useStore.getState().bumpLoadMessagesVersion(targetPath);
  // SessionFile flight 记录（issue #2188）：hydrate 期间到达的 upsert / branch
  // reset 会被下面的 HTTP 快照整表覆盖。开一条 flight 记录桥接两者，hydrate
  // 通过后按 flight 结果决定是丢弃快照还是应用快照 + 重放 flight 期间的 upsert。
  useStore.getState().beginSessionFilesFlight(targetPath, myVersion);
  try {
    const res = await hanaFetch(sessionMessagesUrl(targetPath));
    const data = await res.json();
    const latestVersion =
      sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState()._loadMessagesVersion, targetPath) ?? 0;
    if (latestVersion !== myVersion) {
      // 已经有更新的 loadMessages 在途，stale 响应不应覆盖新状态。
      // todos 与 messages 必须作为同一份 hydrate 快照一起生效或一起丢弃。
      return;
    }
    // SessionFile hydrate（issue #2188）：必须放在 stale 检查之后、
    // messages/todos 的 live-version 早退检查之前——文件 registry 不受这两个
    // 护栏保护范围约束，否则 mid-flight 收到 live message/todo 更新时整次
    // hydrate 被放弃，registry 就会像 bugfix 前那样永远写不进去。
    // 只有 flight 期间没出现过 branch reset 才应用 HTTP 快照——reset 是全量权威
    // 替换，出现过就说明 registry 已经是权威状态（含 reset 后的 upsert），旧
    // 快照绝不能覆盖它。没有 reset 时应用快照后，重放 flight 期间记录的 upsert
    // （upsert 是逐文件权威最新，必须后写生效，恢复被整表快照覆盖掉的增量）。
    const flight = useStore.getState().consumeSessionFilesFlight(targetPath, myVersion);
    if (!flight || !flight.resetSeen) {
      useStore.getState().setSessionRegistryFiles(
        targetPath,
        Array.isArray(data.sessionFiles) ? data.sessionFiles : [],
      );
      for (const f of flight?.upserts ?? []) {
        useStore.getState().upsertSessionRegistryFile(targetPath, f);
      }
    }
    const messageLiveVersionNow = readMessageLiveVersion(targetPath);
    if (messageLiveVersionNow !== messageLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live message 更新',
        targetPath,
      );
      return;
    }
    const todosLiveVersionNow =
      sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().todosLiveVersionBySession, targetPath) ?? 0;
    if (todosLiveVersionNow !== todosLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live todo 更新',
        targetPath,
      );
      return;
    }
    // per-session todos（防御性兼容层：即使后端漏转或缓存残留，这里兜底再转一次）
    const rawTodos = data.todos || [];
    const migratedTodos = migrateLegacyTodos({ todos: rawTodos });
    const items = buildItemsFromHistory(data);
    // 修订点 stamp：记录本次快照对应的磁盘修订点，后续 reconcile 与列表投影对比。
    const revision = typeof data.revision === 'string' ? data.revision : null;
    useStore.getState().setSessionTodosForPath(targetPath, migratedTodos);
    const loop = data.loop && typeof data.loop === 'object' ? data.loop : null;
    useStore.getState().setSessionLoop?.(targetPath, loop);
    if (items.length > 0) {
      useStore.getState().initSession(targetPath, items, data.hasMore ?? false, revision);
      if (targetPath === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
    } else {
      useStore.getState().initSession(targetPath, [], false, revision);
    }
    // In-flight guard: jsonl 仅在 turn_end 落盘。若 session 在 stream 进行中
    // 被 reload（switchSession 冷启动 / stream-resume truncated），合并 buffer
    // 当前快照作为末尾 assistant，避免 UI 上"正在写的消息消失"。
    // 同步执行，不 await，保证中途不会有 text_delta 事件插入。
    const snapshot = snapshotStreamBuffer(targetPath);
    if (snapshot?.hasContent) {
      useStore.getState().appendItem(targetPath, {
        type: 'message',
        data: buildInflightAssistantMessage(snapshot),
      });
    }
  } catch (err) {
    console.error('[loadMessages] error:', err);
    // fetch 失败也要清理本次 flight 记录，避免残留记录被后续 load 误判 version 冲突
    // （不消费返回值：失败路径不需要重放任何东西）。
    useStore.getState().consumeSessionFilesFlight(targetPath, myVersion);
  }
}

export async function completeSessionTodos(sessionPath: string): Promise<boolean> {
  if (!sessionPath) return false;
  const state = useStore.getState();
  if (sessionScopedListIncludes(state as Record<string, any>, state.streamingSessions, sessionPath)) return false;

  try {
    await hanaFetch('/api/sessions/todos/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: sessionPath }),
    });
    useStore.getState().setSessionTodosForPath(sessionPath, []);
    useStore.getState().bumpTodosLiveVersion(sessionPath);
    return true;
  } catch (err) {
    const presented = presentError(err);
    useStore.getState().addToast(
      presented.text,
      'error',
      6000,
      presented.code ? { errorCode: presented.code } : undefined,
    );
    return false;
  }
}

function buildInflightAssistantMessage(snap: StreamBufferSnapshot): ChatMessage {
  const blocks: ContentBlock[] = [];
  if (snap.thinking || snap.inThinking) {
    blocks.push({ type: 'thinking', content: snap.thinking, sealed: !snap.inThinking });
  }
  if (snap.mood) {
    blocks.push({ type: 'mood', yuan: snap.moodYuan, text: snap.mood });
  }
  if (snap.text) {
    const displayText = snap.text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
    blocks.push({ type: 'text', html: renderMarkdown(displayText), source: displayText });
  }
  return { id: snap.messageId || `inflight-${Date.now()}`, role: 'assistant', blocks, timestamp: Date.now() };
}

/**
 * loadMoreMessages 的终态。旧调用方可以继续不读返回值。
 * loaded: 这一页已经接到原窗口前面，且分页游标变旧了。
 * busy: 同一会话已有一次翻页在途，本次没有再发请求。
 * exhausted: 服务端明确没有更早的历史（hasMore=false）。
 * stalled: 空页、全部重复/被过滤，或游标没有变旧。同一 cursor 不会再自动请求。
 * stale: 飞行期间原窗口被替换、会话被拿走或连接换代，旧页已丢弃。
 * failed: HTTP / JSON / 网络失败。不把 hasMore 改成 false。
 */
export type LoadMoreStatus = 'loaded' | 'busy' | 'exhausted' | 'stalled' | 'stale' | 'failed';

export interface LoadMoreMessagesResult {
  status: LoadMoreStatus;
  progressed: boolean;
  cursor?: string;
  nextCursor?: string;
  hasMore?: boolean;
  added?: number;
  reason?: string;
}

export interface LoadMoreMessagesOptions {
  limit?: number;
  /** 显式操作：绕过同一 cursor 的 stalled 门闩，再请求一次。再失败仍会重新闩住。 */
  retry?: boolean;
}

export interface LoadAllOlderOptions {
  /** 用户取消或页面失活。触发后停止继续翻，不等待中的空转。 */
  signal?: AbortSignal;
  /** 返回 false 时停止。旧调用不传。 */
  shouldContinue?: () => boolean;
  /** 等待别人已经发出的那次翻页，毫秒，默认 8000。没有 owner 的孤立 loading 标记不等。 */
  flightWaitMs?: number;
}

const LOAD_MORE_MAX_LIMIT = 200;
const LOAD_ALL_OLDER_PAGE_LIMIT = 200;
const LOAD_ALL_OLDER_MAX_PAGES = 50;
const LOAD_ALL_OLDER_FLIGHT_WAIT_MS = 8_000;

type LoadMoreFlight = {
  token: number;
  promise: Promise<LoadMoreMessagesResult>;
};

type HistoryWindowSnap = {
  sessionId: string | null;
  connectionId: string | null;
  loadVersion: number;
  oldestId: string | undefined;
  anchorId: string | undefined;
  revision: string | null;
};

type HistoryWindowVerdict = 'ok' | 'removed' | 'connection' | 'identity' | 'replaced';

let _loadMoreFlightSeq = 0;
const _loadMoreFlights = new Map<string, LoadMoreFlight>();
const _loadMoreStalledCursor = new Map<string, { cursor: string; sessionId: string | null; connectionId: string | null }>();

function stableHistorySessionId(state: Record<string, any>, path: string): string | null {
  return sessionIdForPathFromLocatorState(state, path);
}

/** 连接 + 稳定会话身份。同一 sessionId 的 path 别名共享 flight；无 sessionId 时退回 path。 */
function loadMoreScopeKey(connectionId: string | null, sessionId: string | null, path: string): string {
  const identity = sessionId ? `session:${sessionId}` : `path:${path}`;
  return `${connectionId ?? ''}\n${identity}`;
}

function connectionIdFromState(state: Record<string, any>): string | null {
  const activeId = state.activeServerConnectionId;
  if (typeof activeId === 'string' && activeId) return activeId;
  const nested = state.activeServerConnection?.connectionId;
  return typeof nested === 'string' && nested ? nested : null;
}

function readLoadMessagesVersion(state: Record<string, any>, path: string): number {
  const value = sessionScopedValue(state, state._loadMessagesVersion, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readChatSession(path: string): any | null {
  const state = useStore.getState() as Record<string, any>;
  return sessionScopedValue(state, state.chatSessions, path) ?? null;
}

function firstHistoryMessageId(items: any): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (item?.type === 'message' && typeof item.data?.id === 'string' && item.data.id) return item.data.id;
  }
  return undefined;
}

function historyItemKey(item: any): string | null {
  if (item?.type === 'message' && typeof item.data?.id === 'string' && item.data.id) {
    return `message:${item.data.id}`;
  }
  if (typeof item?.id === 'string' && item.id) return `${item.type || 'item'}:${item.id}`;
  return null;
}

function snapshotHistoryWindow(path: string, session: any): HistoryWindowSnap {
  const state = useStore.getState() as Record<string, any>;
  return {
    sessionId: stableHistorySessionId(state, path),
    connectionId: connectionIdFromState(state),
    loadVersion: readLoadMessagesVersion(state, path),
    oldestId: typeof session?.oldestId === 'string' ? session.oldestId : undefined,
    anchorId: firstHistoryMessageId(session?.items),
    revision: typeof session?.revision === 'string' ? session.revision : null,
  };
}

function historyWindowVerdict(path: string, snap: HistoryWindowSnap): HistoryWindowVerdict {
  const state = useStore.getState() as Record<string, any>;
  if (connectionIdFromState(state) !== snap.connectionId) return 'connection';
  if (stableHistorySessionId(state, path) !== snap.sessionId) return 'identity';
  const session = sessionScopedValue<SessionMessages>(state, state.chatSessions, path);
  if (!session) return 'removed';
  if (readLoadMessagesVersion(state, path) !== snap.loadVersion) return 'replaced';
  if ((typeof session.revision === 'string' ? session.revision : null) !== snap.revision) return 'replaced';
  if (session.oldestId !== snap.oldestId) return 'replaced';
  if (snap.anchorId) {
    if (firstHistoryMessageId(session.items) !== snap.anchorId) return 'replaced';
    const anchorRemains = Array.isArray(session.items) && session.items.some((item: any) => (
      item?.type === 'message' && item.data?.id === snap.anchorId
    ));
    if (!anchorRemains) return 'replaced';
  }
  return 'ok';
}

function cursorMovedOlder(previous: string | undefined, next: string | undefined): boolean {
  if (!next) return false;
  if (!previous) return false;
  if (next === previous) return false;
  const prevNum = Number(previous);
  const nextNum = Number(next);
  if (Number.isFinite(prevNum) && Number.isFinite(nextNum)) return nextNum < prevNum;
  return true;
}

function readServerHistoryCursor(data: Record<string, any>): string | null {
  for (const key of ['nextBefore', 'oldestCursor', 'nextCursor', 'pageBefore']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function responseIsOk(res: any): boolean {
  if (typeof res?.ok === 'boolean') return res.ok;
  if (typeof res?.status === 'number') return res.status >= 200 && res.status < 300;
  return false;
}

function normalizeLoadMoreLimit(limit: unknown): number | null {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.floor(parsed), LOAD_MORE_MAX_LIMIT);
}

function registryFileIdentity(file: any): string | null {
  const id = typeof file?.fileId === 'string' && file.fileId
    ? file.fileId
    : (typeof file?.id === 'string' && file.id ? file.id : '');
  if (id) return `id:${id}`;
  const filePath = typeof file?.filePath === 'string' && file.filePath
    ? file.filePath
    : (typeof file?.realPath === 'string' && file.realPath ? file.realPath : '');
  return filePath ? `path:${filePath}` : null;
}

function registryFileStamp(file: any): string {
  const version = file?.version;
  if (typeof version === 'string' || typeof version === 'number') return `v:${version}`;
  if (version && typeof version === 'object') {
    const token = version.token ?? version.id ?? version.rev ?? version.etag ?? version.revision;
    if (token != null && token !== '') return `v:${String(token)}`;
  }
  if (typeof file?.mtimeMs === 'number') return `m:${file.mtimeMs}`;
  if (typeof file?.updatedAt === 'number') return `u:${file.updatedAt}`;
  return '';
}

function readRegistryFiles(path: string): any[] {
  const state = useStore.getState() as Record<string, any>;
  const files = sessionScopedValue(state, state.sessionRegistryFilesByPath, path);
  return Array.isArray(files) ? files : [];
}

function snapshotRegistryFiles(path: string): Map<string, { ref: any; stamp: string }> {
  const snap = new Map<string, { ref: any; stamp: string }>();
  for (const file of readRegistryFiles(path)) {
    const key = registryFileIdentity(file);
    if (!key || snap.has(key)) continue;
    snap.set(key, { ref: file, stamp: registryFileStamp(file) });
  }
  return snap;
}

function sessionFilesResetOwnsRegistry(path: string): boolean {
  const state = useStore.getState() as Record<string, any>;
  const flight = sessionScopedValue<{ resetSeen?: boolean }>(state, state._sessionFilesFlightByPath, path);
  return !!flight?.resetSeen;
}

/** 分页快照不能抹掉飞行期间新到或被替换的文件，也不复活本地已删掉的旧记录。 */
function mergeRegistryFiles(
  serverFiles: any[],
  started: Map<string, { ref: any; stamp: string }>,
  currentFiles: any[],
): any[] {
  const currentByKey = new Map<string, any>();
  for (const file of currentFiles) {
    const key = registryFileIdentity(file);
    if (key) currentByKey.set(key, file);
  }
  const liveKeys = new Set<string>();
  for (const [key, file] of currentByKey) {
    const previous = started.get(key);
    if (!previous || previous.ref !== file || previous.stamp !== registryFileStamp(file)) {
      liveKeys.add(key);
    }
  }
  const merged: any[] = [];
  const seen = new Set<string>();
  for (const file of serverFiles) {
    const key = registryFileIdentity(file);
    if (key && liveKeys.has(key)) {
      merged.push(currentByKey.get(key));
      seen.add(key);
      continue;
    }
    if (key && started.has(key) && !currentByKey.has(key)) continue;
    merged.push(file);
    if (key) seen.add(key);
  }
  for (const key of liveKeys) {
    if (seen.has(key)) continue;
    merged.push(currentByKey.get(key));
  }
  return merged;
}

function applyPagedRegistryFiles(
  path: string,
  serverFiles: any[],
  started: Map<string, { ref: any; stamp: string }>,
): void {
  if (sessionFilesResetOwnsRegistry(path)) return;
  const merged = mergeRegistryFiles(serverFiles, started, readRegistryFiles(path));
  useStore.getState().setSessionRegistryFiles(path, merged);
}

function novelHistoryItems(existing: any[], incoming: any[]): any[] {
  const seen = new Set<string>();
  for (const item of existing) {
    const key = historyItemKey(item);
    if (key) seen.add(key);
  }
  const novel: any[] = [];
  for (const item of incoming) {
    const key = historyItemKey(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    novel.push(item);
  }
  return novel;
}

function releaseLoadMoreFlight(path: string, key: string, token: number, snap: HistoryWindowSnap): void {
  const owner = _loadMoreFlights.get(key);
  if (!owner || owner.token !== token) return;
  _loadMoreFlights.delete(key);
  // A hydrate may bump its version and then bail out on live updates/error without
  // replacing the window. Data from this flight is stale, but its busy flag still
  // needs release. Only this layer raises loadingMore; never clear another scope/owner.
  const state = useStore.getState() as Record<string, any>;
  if (connectionIdFromState(state) !== snap.connectionId || stableHistorySessionId(state, path) !== snap.sessionId) return;
  if (_loadMoreFlights.has(loadMoreScopeKey(snap.connectionId, snap.sessionId, path))) return;
  const session = readChatSession(path);
  if (!session?.loadingMore) return;
  if (session.oldestId !== snap.oldestId || firstHistoryMessageId(session.items) !== snap.anchorId
    || (typeof session.revision === 'string' ? session.revision : null) !== snap.revision) return;
  useStore.getState().setLoadingMore(path, false);
}

function loadMoreResult(
  path: string,
  result: LoadMoreMessagesResult,
): LoadMoreMessagesResult {
  const session = readChatSession(path);
  if (!session) return result;
  return {
    ...result,
    cursor: result.cursor ?? (typeof session.oldestId === 'string' ? session.oldestId : undefined),
    nextCursor: result.nextCursor ?? (typeof session.oldestId === 'string' ? session.oldestId : undefined),
    hasMore: result.hasMore ?? !!session.hasMore,
  };
}

function rememberStalledCursor(path: string, snap: HistoryWindowSnap, cursor: string | undefined): void {
  if (cursor == null) return;
  _loadMoreStalledCursor.set(loadMoreScopeKey(snap.connectionId, snap.sessionId, path), {
    cursor,
    sessionId: snap.sessionId,
    connectionId: snap.connectionId,
  });
}

function clearStalledCursor(path: string, snap: HistoryWindowSnap): void {
  _loadMoreStalledCursor.delete(loadMoreScopeKey(snap.connectionId, snap.sessionId, path));
}

/** 上滑加载更早的消息。只拼接历史，不改视口。 */
export async function loadMoreMessages(
  forPath?: string,
  opts?: LoadMoreMessagesOptions,
): Promise<LoadMoreMessagesResult> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return { status: 'failed', progressed: false, reason: 'no-path' };
  const session = readChatSession(targetPath);
  if (!session) return { status: 'failed', progressed: false, reason: 'missing-session' };
  const cursor = typeof session.oldestId === 'string' ? session.oldestId : undefined;
  if (!session.hasMore) {
    return {
      status: 'exhausted',
      progressed: false,
      cursor,
      nextCursor: cursor,
      hasMore: false,
      reason: 'no-more',
    };
  }

  const snap = snapshotHistoryWindow(targetPath, session);
  const flightKey = loadMoreScopeKey(snap.connectionId, snap.sessionId, targetPath);
  const existingFlight = _loadMoreFlights.get(flightKey);
  if (existingFlight) {
    return {
      status: 'busy',
      progressed: false,
      cursor,
      nextCursor: cursor,
      hasMore: !!session.hasMore,
      reason: 'in-flight',
    };
  }
  const stalled = _loadMoreStalledCursor.get(flightKey);
  if (
    !opts?.retry
    && stalled
    && stalled.cursor === (cursor ?? '')
    && stalled.sessionId === snap.sessionId
    && stalled.connectionId === snap.connectionId
  ) {
    return {
      status: 'stalled',
      progressed: false,
      cursor,
      nextCursor: cursor,
      hasMore: !!session.hasMore,
      reason: 'cursor-latched',
    };
  }

  const token = ++_loadMoreFlightSeq;
  let resolveFlight: (result: LoadMoreMessagesResult) => void = () => {};
  const promise = new Promise<LoadMoreMessagesResult>((resolve) => {
    resolveFlight = resolve;
  });
  _loadMoreFlights.set(flightKey, { token, promise });
  void executeLoadMore(targetPath, snap, flightKey, token, cursor, opts).then(
    (result) => resolveFlight(result),
    (err) => {
      console.error('[loadMoreMessages] error:', err);
      resolveFlight({
        status: 'failed',
        progressed: false,
        cursor,
        hasMore: true,
        reason: 'network',
      });
    },
  );
  return promise;
}

async function executeLoadMore(
  path: string,
  snap: HistoryWindowSnap,
  flightKey: string,
  token: number,
  cursor: string | undefined,
  opts: LoadMoreMessagesOptions | undefined,
): Promise<LoadMoreMessagesResult> {
  try {
    useStore.getState().setLoadingMore(path, true);
    const registryAtStart = snapshotRegistryFiles(path);
    const extra: Record<string, string> = { before: cursor ?? '' };
    const explicitLimit = normalizeLoadMoreLimit(opts?.limit);
    if (explicitLimit) extra.limit = String(explicitLimit);
    let res: any;
    try {
      res = await hanaFetch(sessionMessagesUrl(path, extra));
    } catch (err) {
      const verdict = historyWindowVerdict(path, snap);
      if (verdict !== 'ok') {
        return loadMoreResult(path, {
          status: 'stale',
          progressed: false,
          cursor,
          reason: verdict === 'removed'
            ? 'session-removed'
            : verdict === 'connection'
              ? 'connection-changed'
              : verdict === 'identity'
                ? 'session-identity-changed'
                : 'window-replaced',
        });
      }
      console.error('[loadMoreMessages] error:', err);
      return loadMoreResult(path, {
        status: 'failed',
        progressed: false,
        cursor,
        reason: isAbortError(err) ? 'aborted' : 'network',
      });
    }

    const verdict = historyWindowVerdict(path, snap);
    if (verdict !== 'ok') {
      return loadMoreResult(path, {
        status: 'stale',
        progressed: false,
        cursor,
        reason: verdict === 'removed'
          ? 'session-removed'
          : verdict === 'connection'
            ? 'connection-changed'
            : verdict === 'identity'
              ? 'session-identity-changed'
              : 'window-replaced',
      });
    }

    if (!responseIsOk(res)) {
      return loadMoreResult(path, {
        status: 'failed',
        progressed: false,
        cursor,
        reason: `http-${typeof res?.status === 'number' ? res.status : 'error'}`,
      });
    }

    let data: any;
    try {
      data = await res.json();
    } catch (err) {
      console.error('[loadMoreMessages] error:', err);
      return loadMoreResult(path, {
        status: 'failed',
        progressed: false,
        cursor,
        reason: 'invalid-json',
      });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.messages)) {
      return loadMoreResult(path, {
        status: 'failed',
        progressed: false,
        cursor,
        reason: 'invalid-payload',
      });
    }
    if (historyWindowVerdict(path, snap) !== 'ok') {
      return loadMoreResult(path, {
        status: 'stale',
        progressed: false,
        cursor,
        reason: 'window-replaced',
      });
    }

    if (Array.isArray(data.sessionFiles)) {
      applyPagedRegistryFiles(path, data.sessionFiles, registryAtStart);
    }

    let built: any[];
    try {
      built = buildItemsFromHistory(data);
    } catch (err) {
      console.error('[loadMoreMessages] error:', err);
      return loadMoreResult(path, {
        status: 'failed',
        progressed: false,
        cursor,
        reason: 'invalid-payload',
      });
    }
    if (historyWindowVerdict(path, snap) !== 'ok') {
      return loadMoreResult(path, {
        status: 'stale',
        progressed: false,
        cursor,
        reason: 'window-replaced',
      });
    }

    const current = readChatSession(path);
    const novel = novelHistoryItems(Array.isArray(current?.items) ? current.items : [], built);
    const pageOldest = firstHistoryMessageId(built);
    const serverCursor = readServerHistoryCursor(data);
    const messageCursorOk = pageOldest
      ? cursorMovedOlder(cursor, pageOldest)
      : !!(serverCursor && cursorMovedOlder(cursor, serverCursor));
    const serverCursorOk = !serverCursor || cursorMovedOlder(cursor, serverCursor);
    const cursorOk = messageCursorOk && serverCursorOk;
    const hasMoreFlag = typeof data.hasMore === 'boolean' ? data.hasMore : null;

    if (!cursorOk || novel.length === 0) {
      if (hasMoreFlag === false) {
        clearStalledCursor(path, snap);
        useStore.getState().prependItems(path, [], false);
        return loadMoreResult(path, {
          status: 'exhausted',
          progressed: false,
          cursor,
          hasMore: false,
          added: 0,
          reason: novel.length === 0 ? 'empty-tail' : 'cursor-unmoved',
        });
      }
      rememberStalledCursor(path, snap, cursor ?? '');
      return loadMoreResult(path, {
        status: 'stalled',
        progressed: false,
        cursor,
        hasMore: !!current?.hasMore,
        added: 0,
        reason: novel.length === 0 ? (built.length === 0 ? 'empty-page' : 'duplicate-page') : 'cursor-unmoved',
      });
    }

    const nextHasMore = hasMoreFlag === null ? !!current?.hasMore : hasMoreFlag;
    useStore.getState().prependItems(path, novel, nextHasMore);
    const after = readChatSession(path);
    const nextCursor = typeof after?.oldestId === 'string' ? after.oldestId : undefined;
    if (!cursorMovedOlder(cursor, nextCursor)) {
      rememberStalledCursor(path, snap, cursor ?? '');
      return loadMoreResult(path, {
        status: 'stalled',
        progressed: false,
        cursor,
        nextCursor,
        hasMore: !!after?.hasMore,
        added: novel.length,
        reason: 'cursor-unmoved',
      });
    }
    clearStalledCursor(path, snap);
    return loadMoreResult(path, {
      status: 'loaded',
      progressed: true,
      cursor,
      nextCursor,
      hasMore: nextHasMore,
      added: novel.length,
    });
  } finally {
    releaseLoadMoreFlight(path, flightKey, token, snap);
  }
}

function normalizeFlightWait(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LOAD_ALL_OLDER_FLIGHT_WAIT_MS;
  return Math.max(0, value);
}

function isLoadAllCancelled(opts?: LoadAllOlderOptions): boolean {
  if (opts?.signal?.aborted) return true;
  return typeof opts?.shouldContinue === 'function' && !opts.shouldContinue();
}

function waitForOwnedFlight(
  flight: Promise<LoadMoreMessagesResult>,
  budgetMs: number,
  opts?: LoadAllOlderOptions,
): Promise<'done' | 'timeout' | 'cancelled'> {
  if (isLoadAllCancelled(opts)) return Promise.resolve('cancelled');
  if (budgetMs <= 0) return Promise.resolve('timeout');
  return new Promise((resolve) => {
    let settled = false;
    let watcher: ReturnType<typeof setInterval> | undefined;
    const finish = (value: 'done' | 'timeout' | 'cancelled') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watcher) clearInterval(watcher);
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish('cancelled');
    const timer = setTimeout(() => finish('timeout'), budgetMs);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof opts?.shouldContinue === 'function') {
      const shouldContinue = opts.shouldContinue;
      watcher = setInterval(() => {
        if (!shouldContinue()) finish('cancelled');
      }, 200);
    }
    flight.then(
      () => finish(isLoadAllCancelled(opts) ? 'cancelled' : 'done'),
      () => finish(isLoadAllCancelled(opts) ? 'cancelled' : 'done'),
    );
  });
}

async function yieldOlderPageFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function olderFlightFor(path: string): LoadMoreFlight | undefined {
  const session = readChatSession(path);
  if (!session) return undefined;
  const snap = snapshotHistoryWindow(path, session);
  return _loadMoreFlights.get(loadMoreScopeKey(snap.connectionId, snap.sessionId, path));
}

/** 把指定会话当前窗口之前的历史翻完。不切换焦点，也不改视口。 */
export async function loadAllOlderMessages(forPath?: string, opts?: LoadAllOlderOptions): Promise<boolean> {
  const targetPath = typeof forPath === 'string' && forPath.trim()
    ? forPath
    : useStore.getState().currentSessionPath;
  if (!targetPath) return false;
  const deadline = Date.now() + normalizeFlightWait(opts?.flightWaitMs);
  let pages = 0;
  while (pages < LOAD_ALL_OLDER_MAX_PAGES) {
    const session = readChatSession(targetPath);
    if (!session) return false;
    if (!session.hasMore) return true;
    if (isLoadAllCancelled(opts)) return false;
    const flight = olderFlightFor(targetPath);
    if (flight) {
      const waited = await waitForOwnedFlight(flight.promise, deadline - Date.now(), opts);
      if (waited !== 'done') return false;
      continue;
    }
    if (session.loadingMore) return false;
    pages += 1;
    const result = await loadMoreMessages(targetPath, {
      limit: LOAD_ALL_OLDER_PAGE_LIMIT,
      retry: true,
    });
    const after = readChatSession(targetPath);
    if (after && !after.hasMore) return true;
    if (isLoadAllCancelled(opts)) return false;
    if (result.status === 'exhausted') return true;
    if (result.status === 'loaded') {
      if (!result.progressed || result.hasMore === false) return result.hasMore === false;
      await yieldOlderPageFrame();
      continue;
    }
    if (result.status === 'busy') {
      const again = olderFlightFor(targetPath);
      if (!again) return false;
      const waited = await waitForOwnedFlight(again.promise, deadline - Date.now(), opts);
      if (waited !== 'done') return false;
      continue;
    }
    return false;
  }
  return false;
}

// ══════════════════════════════════════════════════════
// 会话修订点校验补拉（issue #1610）
// ══════════════════════════════════════════════════════

// per-session in-flight 去重：focus / online / WS reconnect 等触发器可能同时到达，
// 同一会话同一时刻最多一个补拉请求在途。
const _revisionReconcileInFlight = new Map<string, Promise<void>>();

/**
 * 校验「当前打开会话」的缓存内容是否落后于磁盘真相，落后则补拉。
 *
 * 修订点对比：chatSessions[path].revision（hydrate 时 stamp 的 stat 签名）
 * vs store.sessions 列表投影的 revision（最近一次列表刷新看到的磁盘状态）。
 * 两者不一致说明磁盘在本端没有消费到的窗口内前进过——典型场景是 Bridge /rc
 * 接管期间 web/mobile 端 WS 断连（手机锁屏），live 事件全部丢失。
 *
 * 边界（刻意保守，宁可少拉）：
 *   - 只处理当前打开的会话；后台会话切换回来时由 switchSession 触发同一校验
 *   - 流式进行中不补拉：live 事件流正在喂内容，turn 结束后列表刷新会再触发
 *   - 列表投影无 revision（老服务端 / 内存占位）不盲拉
 *   - 缓存 revision 为 null（未知，如 WS 端新会话的空 init）且列表有 revision
 *     时补拉一次，把修订点 stamp 上
 *
 * 调用方约定：在「拿到新鲜列表之后」调用（loadSessions / loadMobileSessions 之后），
 * 否则对比的是旧投影，没有意义。
 */
export function reconcileCurrentSessionMessages(reason = 'unknown'): Promise<void> | undefined {
  const s = useStore.getState();
  const target = s.currentSessionPath;
  if (!target || s.pendingNewSession || s.pendingSessionSwitchPath) return undefined;
  if (sessionScopedListIncludes(s as Record<string, any>, s.streamingSessions || [], target)) return undefined;
  const cached = sessionScopedValue(s as Record<string, any>, s.chatSessions, target);
  if (!cached) return undefined; // 冷启动 / 切换路径负责首载
  const projection = s.sessions.find((session) => session.path === target);
  const listRevision = typeof projection?.revision === 'string' ? projection.revision : null;
  if (!listRevision) return undefined;
  if ((cached.revision ?? null) === listRevision) return undefined;

  const existing = _revisionReconcileInFlight.get(target);
  if (existing) return existing;

  const inFlight = loadMessages(target)
    .catch((err) => {
      // loadMessages 内部已兜底，这里只防御未来改动让异常冒出导致 in-flight 卡死。
      console.warn(`[session] revision reconcile failed (${reason}):`, err);
    })
    .finally(() => {
      _revisionReconcileInFlight.delete(target);
    });
  _revisionReconcileInFlight.set(target, inFlight);
  return inFlight;
}

// ══════════════════════════════════════════════════════
// Session 列表
// ══════════════════════════════════════════════════════

// 与 /api/sessions 并行探测 session 元数据待恢复状态（/api/health 的
// sessionStore 附块）。失败/超时一律静默忽略——这只是一个附加提示信号，绝不能
// 让健康检查探测的失败反过来拖垮或延后会话列表本身的加载。
async function fetchSessionMetaRecoveryStatus(): Promise<SessionMetaRecoveryStatus | null> {
  try {
    const res = await hanaFetch('/api/health');
    const data = await res.json();
    return (data && typeof data === 'object' && data.sessionStore) || null;
  } catch {
    return null;
  }
}

export async function loadSessions(): Promise<void> {
  // 先发起 /api/sessions（调用顺序上排在前面，保持它是 loadSessions() 触发的
  // 第一个 hanaFetch 调用——调用方/测试对"/api/sessions 是这次加载的第一个
  // 请求"这个顺序有既有假设），紧接着不等待地发起 /api/health 探测：两个请求
  // 仍然背靠背同时打到网络上，只是调用顺序固定，不会因为并行而变得不确定。
  const sessionsFetchPromise = hanaFetch('/api/sessions');
  const metaRecoveryPromise = fetchSessionMetaRecoveryStatus();
  try {
    const res = await sessionsFetchPromise;
    const data = await res.json();
    const serverSessions = Array.isArray(data) ? data.map(normalizeServerSessionProjection) : [];
    const localSessions = useStore.getState().sessions || [];
    const sessions = mergeSessionsWithOptimisticFirstMessages(serverSessions, localSessions);

    useStore.setState((state: any) => {
      const sessionLocatorsById = mergeSessionLocators(state.sessionLocatorsById || {}, sessions);
      const currentSessionId = typeof state.currentSessionId === 'string' && state.currentSessionId.trim()
        ? state.currentSessionId.trim()
        : null;
      const currentLocatorPath = currentSessionId
        && !state.pendingNewSession
        && !state.pendingSessionSwitchPath
        ? sessionLocatorsById[currentSessionId]?.path || null
        : null;
      return {
        sessions,
        sessionLocatorsById,
        ...(currentLocatorPath && currentLocatorPath !== state.currentSessionPath
          ? { currentSessionPath: currentLocatorPath }
          : {}),
      };
    });

    const latest = useStore.getState();
    if (
      sessions.length > 0
      && !latest.currentSessionPath
      && !latest.pendingNewSession
      && !latest.pendingSessionSwitchPath
    ) {
      // 首次加载：走完整的 switchSession 确保后端同步 + 消息加载
      await switchSession(sessions[0].path);
    }
  } catch { /* ignore */ }
  useStore.getState().setSessionMetaRecovery(await metaRecoveryPromise);
}

const EMPTY_FIRST_MESSAGE_PLACEHOLDER = '(no messages)';

function nonPlaceholderText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === EMPTY_FIRST_MESSAGE_PLACEHOLDER ? '' : trimmed;
}

function normalizeServerSessionProjection(session: any): any {
  if (!session || typeof session !== 'object') return session;
  if (session.firstMessage === EMPTY_FIRST_MESSAGE_PLACEHOLDER) {
    return { ...session, firstMessage: '' };
  }
  return session;
}

function withoutOptimisticFirstMessageMarker(session: any): any {
  if (!session || typeof session !== 'object') return session;
  if (!session._optimisticFirstMessage) return session;
  const { _optimisticFirstMessage, ...rest } = session;
  return rest;
}

function isOptimisticFirstMessageProjection(session: any): boolean {
  return !!(session && session._optimisticFirstMessage && Number(session.messageCount || 0) > 0);
}

function serverProjectionHasPersistedContent(session: any): boolean {
  return Number(session?.messageCount || 0) > 0
    || !!nonPlaceholderText(session?.firstMessage)
    || !!nonPlaceholderText(session?.title);
}

function shouldKeepOptimisticFirstMessage(serverSession: any, localSession: any): boolean {
  return isOptimisticFirstMessageProjection(localSession)
    && !serverProjectionHasPersistedContent(serverSession);
}

function mergeSessionsWithOptimisticFirstMessages(serverSessions: any[], localSessions: any[]): any[] {
  const localByPath = new Map<string, any>();
  for (const session of localSessions) {
    if (typeof session?.path === 'string' && isOptimisticFirstMessageProjection(session)) {
      localByPath.set(session.path, session);
    }
  }
  if (localByPath.size === 0) return serverSessions.map(withoutOptimisticFirstMessageMarker);

  const seenPaths = new Set<string>();
  const merged = serverSessions.map((serverSession) => {
    const path = typeof serverSession?.path === 'string' ? serverSession.path : null;
    if (!path) return withoutOptimisticFirstMessageMarker(serverSession);
    seenPaths.add(path);
    const localSession = localByPath.get(path);
    if (!shouldKeepOptimisticFirstMessage(serverSession, localSession)) {
      return withoutOptimisticFirstMessageMarker(serverSession);
    }
    return {
      ...localSession,
      ...serverSession,
      firstMessage: nonPlaceholderText(localSession.firstMessage),
      messageCount: Math.max(Number(localSession.messageCount || 0), 1),
      modified: localSession.modified,
      _optimisticFirstMessage: true,
    };
  });

  const localOnly = Array.from(localByPath.values()).filter((session) => !seenPaths.has(session.path));
  return [...localOnly, ...merged];
}

export function upsertOptimisticSessionFirstMessage(
  sessionPath: string | null | undefined,
  messageText: string,
  timestamp = new Date().toISOString(),
): void {
  const path = typeof sessionPath === 'string' && sessionPath.trim() ? sessionPath : null;
  if (!path) return;

  useStore.setState((state: any) => {
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const existingIndex = sessions.findIndex((session: any) => session?.path === path);
    const existing = existingIndex >= 0 ? sessions[existingIndex] : null;
    if (existing && !isOptimisticFirstMessageProjection(existing) && serverProjectionHasPersistedContent(existing)) {
      return {};
    }
    const sessionId = normalizeSessionId(existing?.sessionId)
      || (state.currentSessionPath === path ? normalizeSessionId(state.currentSessionId) : null)
      || sessionIdForPathFromState(state, path);
    const firstMessage = nonPlaceholderText(existing?.firstMessage) || nonPlaceholderText(messageText);
    const messageCount = Math.max(Number(existing?.messageCount || 0), 1);
    const optimisticProjection = {
      ...(existing || {}),
      path,
      ...(sessionId ? { sessionId } : {}),
      agentId: existing?.agentId ?? state.currentAgentId ?? state.selectedAgentId ?? null,
      agentName: existing?.agentName ?? state.agentName ?? '',
      cwd: existing?.cwd ?? state.deskBasePath ?? state.selectedFolder ?? '',
      projectId: existing?.projectId ?? state.pendingProjectId ?? null,
      workspaceMountId: existing?.workspaceMountId ?? state.deskWorkspaceMountId ?? state.selectedWorkspaceMountId ?? null,
      workspaceLabel: existing?.workspaceLabel ?? state.deskWorkspaceLabel ?? state.selectedWorkspaceLabel ?? null,
      firstMessage,
      messageCount,
      modified: timestamp,
      created: existing?.created ?? timestamp,
      _optimisticFirstMessage: true,
    };
    const nextSessions = existingIndex >= 0
      ? sessions.map((session: any, index: number) => (index === existingIndex ? optimisticProjection : session))
      : [optimisticProjection, ...sessions];
    return {
      sessions: nextSessions,
      sessionLocatorsById: mergeSessionLocators(state.sessionLocatorsById || {}, nextSessions),
    };
  });
}

// ══════════════════════════════════════════════════════
// Session 切换
// ══════════════════════════════════════════════════════

export async function switchSession(path: string): Promise<void> {
  const s = useStore.getState();
  const myVersion = ++_switchVersion;
  _switchAbortController?.abort();
  _switchAbortController = null;

  if (path === s.currentSessionPath && !s.pendingNewSession) {
    useStore.setState(state => ({
      pendingSessionSwitchPath: null,
      unreadOutputSessionPaths: filterSessionScopedStateList(state as Record<string, any>, state.unreadOutputSessionPaths || [], path),
    }));
    return;
  }

  useStore.getState().clearStaleMessageLocate(path);
  useStore.setState({ pendingSessionSwitchPath: path });

  if (isDeletedAgentSession(path)) {
    await switchDeletedAgentSession(path, myVersion);
    return;
  }

  // 关闭浮动面板
  const activePanel = useStore.getState().activePanel;
  if (activePanel === 'activity' || activePanel === 'automation') {
    useStore.getState().setActivePanel(null);
  }

  const abortController = new AbortController();
  _switchAbortController = abortController;
  const targetSessionId = sessionIdForPathFromState(s as Record<string, any>, path);

  try {
    const res = await hanaFetch('/api/sessions/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        currentSessionPath: s.currentSessionPath,
      }),
      signal: abortController.signal,
    });
    const data = await res.json();
    if (!isCurrentSwitch(myVersion, path)) return;
    if (data.error) {
      // 带上错误码，呈现层才能把它翻成人话；没有码的原生崩溃走兜底文案 + 详情。
      const routeError = normalizeSessionRouteError(data);
      console.error('[session] switch failed:', routeError.message, routeError.code || '');
      useStore.setState({ pendingSessionSwitchPath: null });
      showSessionSwitchError(path, errorWithCode(routeError.message, routeError.code));
      return;
    }

    const state = useStore.getState();

    // 以服务端事实对齐当前 session 的流式状态。刷新或重连后，renderer 的本地集合可能已经过期。
    const isStreaming = data.isStreaming === true;
    const streamingSessions = reconcileStreamingSessionsForPath(state as Record<string, any>, state.streamingSessions, path, isStreaming);
    const activeSessionStreams = { ...(state.activeSessionStreams || {}) };
    const activeStreamKey = sessionScopedKey(state as Record<string, any>, path) || path;
    if (isStreaming) {
      activeSessionStreams[activeStreamKey] = activeSessionStreams[activeStreamKey]
        || activeSessionStreams[path]
        || { streamId: null, turnId: null };
      if (activeStreamKey !== path) delete activeSessionStreams[path];
    } else {
      delete activeSessionStreams[activeStreamKey];
      delete activeSessionStreams[path];
    }

    // 同步全局 agent 上下文
    const switchedAgent = data.agentId && data.agentId !== state.currentAgentId;
    const agentPatch: Record<string, any> = {};

    if (switchedAgent) {
      const ag = state.agents.find((a: any) => a.id === data.agentId);
      agentPatch.currentAgentId = data.agentId;
      agentPatch.agentName = data.agentName || ag?.name || data.agentId;
      agentPatch.agentYuan = ag?.yuan || 'hanako';
      agentPatch.agentAvatarUrl = ag?.hasAvatar ? hanaUrl(`/api/agents/${data.agentId}/avatar?t=${Date.now()}`) : null;
      agentPatch.homeFolder = typeof ag?.homeFolder === 'string' && ag.homeFolder.trim()
        ? ag.homeFolder.trim()
        : null;
    }

    // 保存当前 session 的附件到 keyed store
    const currentPath = s.currentSessionPath;
    const currentAttachments = state.attachedFiles;
    if (currentPath) {
      useStore.setState(prev => ({
        attachedFilesBySession: putSessionScopedStateValue(
          prev as Record<string, any>,
          prev.attachedFilesBySession || {},
          currentPath,
          [...currentAttachments],
        ),
      }));
    }

    // 在设置 currentSessionPath 之前预加载消息历史。
    // 一旦 currentSessionPath 指向新 session，主窗口 WebSocket 会将该 session 的流式事件
    // 路由到 streamBufferManager，触发 bumpMessageLiveVersion，导致 loadMessages 的
    // 竞态守卫跳过 hydrate，store 丢失完整历史。提前加载可避免此竞态。
    const hasData = !!sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().chatSessions, path);
    if (!hasData) {
      await loadMessages(path);
      if (myVersion !== _switchVersion) return;
    }

    // 批量更新 store（切 currentSessionPath 切换对话内容；可见 desk/preview 状态由 workspace 激活流程恢复）
    useStore.setState((prev: any) => ({
      ...currentSessionIdentityPatch(prev, path, data.sessionId),
      pendingSessionSwitchPath: null,
      pendingNewSession: false,
      pendingDraftId: null,
      pendingProjectId: null,
      pendingNewSessionThinkingLevel: null,
      pendingNewSessionPermissionMode: null,
      selectedFolder: null,
      selectedWorkspaceMountId: null,
      selectedWorkspaceLabel: null,
      workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
      sessionAuthorizedFoldersByPath: {
        ...putSessionScopedStateValue(
          state,
          state.sessionAuthorizedFoldersByPath || {},
          path,
          Array.isArray(data.authorizedFolders) ? data.authorizedFolders : [],
        ),
      },
      selectedAgentId: null,
      welcomeVisible: false,
      memoryEnabled: data.memoryEnabled !== false,
      streamingSessions,
      activeSessionStreams,
      unreadOutputSessionPaths: filterSessionScopedStateList(state as Record<string, any>, state.unreadOutputSessionPaths || [], path),
      attachedFiles: sessionScopedValue(state as Record<string, any>, state.attachedFilesBySession || {}, path) || [],
      deskContextAttached: false,
      docContextAttached: false,
      ...agentPatch,
    }));

    // 缓存命中跳过了 loadMessages 时，校验修订点：会话在后台期间（如 Bridge /rc
    // 接管 + 本端 WS 断连）磁盘可能已前进，缓存不能直接当真相（issue #1610）。
    // fire-and-forget：先呈现缓存内容，补拉结果通过 store 更新自然落地。
    if (hasData) {
      void reconcileCurrentSessionMessages('session_switch');
    }

    await resetDeskForSessionWorkspace({
      cwd: data.cwd || null,
      workspaceMountId: data.workspaceMountId || null,
      workspaceLabel: data.workspaceLabel || null,
    });
    if (myVersion !== _switchVersion) return;

    // 同步浏览器状态到 keyed store（服务端返回当前 session 的 browser 状态）
    if (path) {
      setBrowserStateForPath(path, {
        running: !!data.browserRunning,
        url: data.browserUrl || null,
        thumbnail: data.browserRunning ? (browserStateForPath(state as any, path).thumbnail ?? null) : null,
      });
    }

    useStore.getState().clearQuotedSelection();

    emitSessionPermissionMode(data.permissionMode || data.accessMode);
    if (data.thinkingLevel) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
    }

    // 刷新模型列表（当前 session 的模型可能不同）
    loadModels();

    // Hydrate per-session model snapshot from switch response。
    // provider 缺失不写入——空 provider 会让 ModelSelector 的复合键匹配全错
    // （老 session 的 meta 可能没带 provider，走 migration 或下一次显式选择修复）。
    if (data.currentModelId && data.currentModelProvider) {
      useStore.getState().updateSessionModel(path, {
        id: data.currentModelId,
        name: data.currentModelName || data.currentModelId,
        provider: data.currentModelProvider,
        input: Array.isArray(data.currentModelInput) ? data.currentModelInput : undefined,
        video: data.currentModelVideo ?? undefined,
        videoTransport: data.currentModelVideoTransport ?? undefined,
        videoTransportSupported: data.currentModelVideoTransportSupported ?? undefined,
        audio: data.currentModelAudio ?? undefined,
        audioTransport: data.currentModelAudioTransport ?? undefined,
        audioTransportSupported: data.currentModelAudioTransportSupported ?? undefined,
        reasoning: data.currentModelReasoning ?? undefined,
        xhigh: data.currentModelXhigh ?? undefined,
        thinkingLevels: Array.isArray(data.currentModelThinkingLevels) ? data.currentModelThinkingLevels : undefined,
        defaultThinkingLevel: data.currentModelDefaultThinkingLevel ?? undefined,
        contextWindow: data.currentModelContextWindow ?? undefined,
        available: data.currentModelAvailable !== false,
        unavailableReason: data.currentModelAvailable === false
          ? (data.currentModelUnavailableReason || 'temporarily_unavailable')
          : null,
      });
    }

    await requestActiveSessionStreamResume(path, isStreaming);
    if (myVersion !== _switchVersion) return;

    // 切换会话后刷新 context ring
    useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
    import('../services/websocket').then(({ getWebSocket }) => {
      const wsConn = getWebSocket();
      if (wsConn?.readyState === WebSocket.OPEN) {
        const sessionId = sessionIdForPathFromState(useStore.getState() as Record<string, any>, path);
        wsConn.send(JSON.stringify({
          type: 'context_usage',
          sessionPath: path,
          ...(sessionId ? { sessionId } : {}),
        }));
      }
    }).catch((err) => {
      console.warn('[session] context usage refresh skipped:', err);
    });

    // Restore input focus only if the user is still in the chat surface that initiated the switch.
    requestChatInputFocus(path);
  } catch (err) {
    if (myVersion !== _switchVersion || isAbortError(err)) return;
    useStore.setState((state: Record<string, any>) => (
      state.pendingSessionSwitchPath === path ? { pendingSessionSwitchPath: null } : {}
    ));
    console.error('[session] switch failed:', err);
    showSessionSwitchError(path, err);
  } finally {
    if (_switchAbortController === abortController) {
      _switchAbortController = null;
    }
  }
}

async function switchDeletedAgentSession(path: string, version: number): Promise<void> {
  const state = useStore.getState();
  const projection = findSessionProjection(path);
  const currentPath = state.currentSessionPath;
  const currentAttachments = state.attachedFiles;
  if (currentPath) {
    useStore.setState(prev => ({
      attachedFilesBySession: putSessionScopedStateValue(
        prev as Record<string, any>,
        prev.attachedFilesBySession || {},
        currentPath,
        [...currentAttachments],
      ),
    }));
  }

  useStore.setState({
    ...currentSessionIdentityPatch(state as Record<string, any>, path, projection?.sessionId),
    currentSessionPath: path,
    pendingSessionSwitchPath: null,
    pendingNewSession: false,
    pendingDraftId: null,
    pendingProjectId: null,
    selectedFolder: null,
    selectedWorkspaceMountId: null,
    selectedWorkspaceLabel: null,
    workspaceFolders: [],
    sessionAuthorizedFoldersByPath: {
      ...putSessionScopedStateValue(state, state.sessionAuthorizedFoldersByPath || {}, path, []),
    },
    selectedAgentId: null,
    welcomeVisible: false,
    streamingSessions: filterSessionScopedStateList(state as Record<string, any>, state.streamingSessions, path),
    activeSessionStreams: Object.fromEntries(
      Object.entries(state.activeSessionStreams || {}).filter(([sessionPath]) => {
        const key = sessionScopedKey(state as Record<string, any>, path) || path;
        return sessionPath !== key && sessionPath !== path;
      }),
    ),
    unreadOutputSessionPaths: filterSessionScopedStateList(state as Record<string, any>, state.unreadOutputSessionPaths || [], path),
    attachedFiles: sessionScopedValue(state as Record<string, any>, state.attachedFilesBySession || {}, path) || [],
    deskContextAttached: false,
    docContextAttached: false,
  });

  await resetDeskForSessionWorkspace({
    cwd: projection?.cwd || null,
    workspaceMountId: (projection as any)?.workspaceMountId || null,
    workspaceLabel: (projection as any)?.workspaceLabel || null,
  });
  if (version !== _switchVersion) return;

  useStore.getState().clearQuotedSelection();
  emitSessionPermissionMode('read_only');

  const hasData = !!sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().chatSessions, path);
  if (!hasData) {
    await loadMessages(path);
  }
}

// ══════════════════════════════════════════════════════
// 新建 Session
// ══════════════════════════════════════════════════════

interface CreateNewSessionOptions {
  projectId?: string | null;
  cwd?: string | null;
}

type PendingSessionCreateBody = Record<string, any>;

function buildPendingSessionCreateBody(state: Record<string, any>): PendingSessionCreateBody {
  const body: PendingSessionCreateBody = {
    memoryEnabled: state.memoryEnabled,
    recordWorkspaceHistory: true,
  };
  if (state.selectedWorkspaceMountId) {
    body.workspaceMountId = state.selectedWorkspaceMountId;
  } else if (state.selectedFolder) {
    body.cwd = state.selectedFolder;
  }
  if (state.workspaceFolders?.length) {
    body.workspaceFolders = state.workspaceFolders;
  }
  if (state.pendingProjectId) {
    body.projectId = state.pendingProjectId;
  }
  if (state.pendingNewSessionThinkingLevel) {
    body.thinkingLevel = state.pendingNewSessionThinkingLevel;
  }
  if (state.pendingNewSessionPermissionMode) {
    body.permissionMode = state.pendingNewSessionPermissionMode;
  }
  if (state.selectedAgentId && state.selectedAgentId !== state.currentAgentId) {
    body.agentId = state.selectedAgentId;
  }
  body.currentSessionPath = state.currentSessionPath;
  return body;
}

function pendingSessionCreateKey(body: PendingSessionCreateBody): string {
  return JSON.stringify(body);
}

function currentPendingSessionDraft(): { body: PendingSessionCreateBody; key: string } | null {
  const state = useStore.getState() as Record<string, any>;
  if (state.pendingNewSession !== true || !normalizeSessionId(state.pendingDraftId)) return null;
  const body = buildPendingSessionCreateBody(state);
  return { body, key: `${state.pendingDraftId}:${pendingSessionCreateKey(body)}` };
}

async function postPendingSessionCreate(body: PendingSessionCreateBody): Promise<any> {
  const res = await hanaFetch('/api/sessions/new-detached', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    throwOnHttpError: false,
  });
  return res.json();
}

function stageDetachedSessionForActivation(data: any, ref: Readonly<SessionRef>, state: Record<string, any>): void {
  const existing = sessionByIdentityOrPath(state, ref.sessionId, ref.sessionPath);
  const projection = {
    ...(existing || {}),
    path: ref.sessionPath,
    sessionId: ref.sessionId,
    agentId: ref.agentId,
    agentName: data.agentName || existing?.agentName || ref.agentId,
    cwd: data.cwd || existing?.cwd || null,
    workspaceMountId: data.workspaceMountId || existing?.workspaceMountId || null,
    workspaceLabel: data.workspaceLabel || existing?.workspaceLabel || null,
    title: existing?.title ?? null,
    firstMessage: existing?.firstMessage ?? '',
    modified: existing?.modified || new Date().toISOString(),
    messageCount: existing?.messageCount ?? 0,
    _optimistic: true,
  };
  const sessions = [projection, ...(state.sessions || []).filter((item: any) => (
    normalizeSessionId(item?.sessionId) !== ref.sessionId && item?.path !== ref.sessionPath
  ))];
  const targetKey = ref.sessionId;
  useStore.setState({
    sessions,
    sessionLocatorsById: {
      ...(state.sessionLocatorsById || {}),
      [ref.sessionId]: { path: ref.sessionPath },
    },
    attachedFilesBySession: {
      ...(state.attachedFilesBySession || {}),
      [targetKey]: [...(state.attachedFiles || [])],
    },
  });
  useStore.getState().initSession?.(ref.sessionPath, [], false);
}

export async function loadPendingNewSessionPermissionDefault(): Promise<SessionPermissionMode> {
  try {
    const res = await hanaFetch('/api/preferences/session-permission-default');
    const data = await res.json();
    const mode = normalizeSessionPermissionMode(data.permissionMode);
    if (isPendingNewSessionDraftView()) emitSessionPermissionMode(mode);
    return mode;
  } catch (err) {
    console.warn('[session] load permission default failed:', err);
    if (isPendingNewSessionDraftView()) emitSessionPermissionMode('ask');
    return 'ask';
  }
}

export async function createNewSession(options: CreateNewSessionOptions = {}): Promise<void> {
  // Entering the pending new-session workspace is a navigation boundary.
  // Any in-flight switchSession response now belongs to the previous view.
  invalidateSessionSwitches();

  // 关闭浮动面板
  if (useStore.getState().activePanel === 'activity') {
    useStore.getState().setActivePanel(null);
  }

  const s = useStore.getState();
  const primaryAgent = findPrimaryAgent(s.agents);
  const primaryWorkspace = resolveAgentWorkspace(primaryAgent);
  const requestedFolder = typeof options.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : null;
  const defaultWorkspaceMountId = null;
  const defaultWorkspaceLabel = null;
  const defaultFolder = requestedFolder || primaryWorkspace || (!primaryAgent ? s.homeFolder : null) || null;
  const selectedPrimaryAgentId = primaryAgent && primaryAgent.id !== s.currentAgentId
    ? primaryAgent.id
    : null;
  const pendingProjectId = typeof options.projectId === 'string' && options.projectId.trim()
    ? options.projectId.trim()
    : null;

  useStore.setState({
    welcomeVisible: true,
    currentSessionPath: null,
    currentSessionId: null,
    pendingSessionSwitchPath: null,
    // 全局新建始终回到 Primary Agent。显式项目 cwd 只覆盖本次工作目录；
    // 普通新建使用 Primary Agent 的有效工作区（显式 home 或服务端默认工作区）。
    selectedFolder: defaultFolder,
    selectedWorkspaceMountId: defaultWorkspaceMountId,
    selectedWorkspaceLabel: defaultWorkspaceLabel,
    workspaceFolders: [],
    selectedAgentId: selectedPrimaryAgentId,
    ...pendingNewSessionIdentityPatch(),
    pendingProjectId,
    pendingNewSessionThinkingLevel: null,
    pendingNewSessionPermissionMode: null,
    attachedFiles: [],
    deskContextAttached: false,
    docContextAttached: false,
  });

  await activateWorkspaceDesk(defaultFolder, {
    mountId: defaultWorkspaceMountId,
    label: defaultWorkspaceLabel,
  });

  // 重置 context ring
  useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
  await loadPendingNewSessionPermissionDefault();

  try {
    const res = await hanaFetch('/api/session-thinking-level?pendingNewSession=1');
    const data = await res.json();
    if (data.thinkingLevel && isPendingNewSessionDraftView()) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
      useStore.getState().setPendingNewSessionThinkingLevel(data.thinkingLevel);
    }
  } catch {
    useStore.getState().setPendingNewSessionThinkingLevel(null);
  }

  // pending 状态下刷新 model 列表，让 ModelSelector 显示 agent Chat 默认 model
  loadModels();

  requestChatInputFocus(null);
}

// ══════════════════════════════════════════════════════
// 确保 Session 存在（首次发消息时调用）
// ══════════════════════════════════════════════════════

export async function ensureSession(expectedPendingDraftId?: string | null): Promise<Readonly<SessionRef> | null> {
  try {
    const initialState = useStore.getState() as Record<string, any>;
    if (initialState.pendingNewSession !== true) return frozenSessionRefFromState(initialState);
    const draft = currentPendingSessionDraft();
    if (!draft) throw new Error('pending session draft identity is missing');
    const draftId = normalizeSessionId(initialState.pendingDraftId);
    if (expectedPendingDraftId && draftId !== expectedPendingDraftId) return null;

    const data = await postPendingSessionCreate(draft.body);
    // 带上错误码，呈现层才能把它翻成人话；没有码的原生崩溃走兜底文案 + 详情。
    if (data?.error) {
      const routeError = normalizeSessionRouteError(data);
      throw errorWithCode(routeError.message, routeError.code);
    }
    const ref = frozenSessionRefFromCreateResponse(data);
    if (!ref) throw new Error('session creation returned an incomplete session identity');

    const latestDraft = currentPendingSessionDraft();
    const latestState = useStore.getState() as Record<string, any>;
    const stillOwnsPendingView = latestDraft?.key === draft.key
      && normalizeSessionId(latestState.pendingDraftId) === draftId;
    if (!stillOwnsPendingView) return ref;

    stageDetachedSessionForActivation(data, ref, latestState);
    await switchSession(ref.sessionPath);
    const activated = useStore.getState() as Record<string, any>;
    if (activated.currentSessionId === ref.sessionId && activated.currentSessionPath === ref.sessionPath) {
      activated.clearDraft?.(HOME_DRAFT_KEY);
      activated.clearDraft?.(ref.sessionId);
      activated.clearDraft?.(ref.sessionPath);
      useStore.setState({ pendingDraftId: null });
    }
    return ref;
  } catch (err) {
    console.error('[session] create failed:', err);
    showSessionCreationError(err);
    return null;
  }
}

export async function continueDeletedAgentSession(path: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/continue-deleted-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.path) {
      const routeError = normalizeSessionRouteError(data);
      const message = routeError.message || res.statusText || 'continue failed';
      console.error('[session] continue deleted-agent session failed:', message, routeError.code || '');
      // 跟下面 catch 分支同一套呈现：错误码翻成人话。这是侧栏动作，当前会话未必能挂 inline。
      const entry = presentErrorWithLabel(
        tr('session.deletedAgent.continueFailed'),
        errorWithCode(message, routeError.code),
      );
      useStore.getState().addToast(entry.text, 'error', 6000, entry.code ? { errorCode: entry.code } : undefined);
      return false;
    }

    await loadSessions();
    await switchSession(data.path);
    if (data.compactionError) {
      useStore.getState().addToast(
        `${tr('session.deletedAgent.continueCompactionFailed')}: ${data.compactionError}`,
        'warning',
        6000,
      );
    }
    return true;
  } catch (err) {
    console.error('[session] continue deleted-agent session failed:', err);
    useStore.getState().addToast(
      presentErrorWithLabel(tr('session.deletedAgent.continueFailed'), err).text,
      'error',
      6000,
    );
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 归档 Session
// ══════════════════════════════════════════════════════

export async function archiveSession(path: string): Promise<void> {
  try {
    const localSessionId = sessionIdForPathFromState(useStore.getState() as Record<string, any>, path);
    const res = await hanaFetch('/api/sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        ...(localSessionId ? { sessionId: localSessionId } : {}),
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] archive failed:', data.error);
      showSidebarToast(window.t('session.archiveFailed'));
      return;
    }

    const s = useStore.getState();
    const isCurrent = path === s.currentSessionPath;
    clearSessionRuntimeCaches(path);
    if (isCurrent) {
      clearChatAction();
      useStore.setState({ currentSessionPath: null, currentSessionId: null });
    }

    await loadSessions();

    const updated = useStore.getState();
    if (updated.sessions.length === 0) {
      await createNewSession();
    } else if (!updated.currentSessionPath) {
      await switchSession(updated.sessions[0].path);
    }
  } catch (err) {
    console.error('[session] archive failed:', err);
    showSidebarToast(window.t('session.archiveFailed'));
  }
}

// ══════════════════════════════════════════════════════
// 归档管理：列出 / 恢复 / 永久删 / 批量清理
// ══════════════════════════════════════════════════════

export interface ArchivedSession {
  path: string;
  sessionId?: string | null;
  title: string | null;
  archivedAt: string;
  sizeBytes: number;
  agentId: string;
  agentName: string;
  agentDeleted?: boolean;
  readOnlyReason?: string | null;
  deletedAt?: string | null;
}

export type RestoreResult =
  | { status: 'ok'; restoredPath: string | null; sessionId: string | null }
  | { status: 'conflict'; error?: string }
  | { status: 'error'; error?: string };

export async function listArchivedSessions(): Promise<ArchivedSession[]> {
  try {
    const res = await hanaFetch('/api/sessions/archived');
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error('[archived] list failed:', err);
    return [];
  }
}

export async function restoreSession(target: string | Pick<ArchivedSession, 'path' | 'sessionId'>): Promise<RestoreResult> {
  const sessionPath = typeof target === 'string' ? target : target.path;
  const sessionId = typeof target === 'string' ? null : normalizeSessionId(target.sessionId);
  try {
    const res = await hanaFetch('/api/sessions/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: sessionPath,
        ...(sessionId ? { sessionId } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) return { status: 'conflict', error: data?.error };
    if (!res.ok) return { status: 'error', error: data?.error || res.statusText };
    const restoredPath = typeof data?.restoredPath === 'string' ? data.restoredPath : null;
    const restoredSessionId = normalizeSessionId(data?.sessionId) || sessionId;

    await loadSessions();
    const restoredSession = sessionByIdentityOrPath(
      useStore.getState() as Record<string, any>,
      restoredSessionId,
      restoredPath,
    );
    if (restoredSession?.path) {
      await switchSession(restoredSession.path);
    }
    void hydrateInputDrafts();
    return { status: 'ok', restoredPath, sessionId: restoredSessionId };
  } catch (err) {
    console.error('[archived] restore failed:', err);
    return { status: 'error', error: errorMessage(err) };
  }
}

export async function deleteArchivedSession(target: string | Pick<ArchivedSession, 'path' | 'sessionId'>): Promise<boolean> {
  const sessionPath = typeof target === 'string' ? target : target.path;
  const sessionId = typeof target === 'string' ? null : normalizeSessionId(target.sessionId);
  try {
    const res = await hanaFetch('/api/sessions/archived/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: sessionPath,
        ...(sessionId ? { sessionId } : {}),
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[archived] delete failed:', err);
    return false;
  }
}

export async function cleanupArchivedSessions(maxAgeDays: 30 | 90): Promise<{ deleted: number }> {
  try {
    const res = await hanaFetch('/api/sessions/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeDays }),
    });
    if (!res.ok) return { deleted: 0 };
    const data = await res.json();
    return { deleted: data.deleted ?? 0 };
  } catch (err) {
    console.error('[archived] cleanup failed:', err);
    return { deleted: 0 };
  }
}

// ══════════════════════════════════════════════════════
// 重命名 Session
// ══════════════════════════════════════════════════════

export async function renameSession(path: string, title: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, title }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] rename failed:', data.error);
      return false;
    }
    // 乐观更新 store 中的 title
    const sessions = useStore.getState().sessions.map(s =>
      s.path === path ? { ...s, title } : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] rename failed:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 置顶 / 取消置顶 Session
// ══════════════════════════════════════════════════════

export async function pinSession(path: string, pinned: boolean): Promise<boolean> {
  try {
    const localSessionId = sessionIdForPathFromState(useStore.getState() as Record<string, any>, path);
    const res = await hanaFetch('/api/sessions/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        ...(localSessionId ? { sessionId: localSessionId } : {}),
        pinned,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error('[session] pin failed:', data.error || res.statusText);
      showSidebarToast(window.t(pinned ? 'session.pinFailed' : 'session.unpinFailed'));
      return false;
    }

    const pinnedAt = typeof data.pinnedAt === 'string' ? data.pinnedAt : null;
    const responseSessionId = normalizeSessionId(data.sessionId) || localSessionId;
    const sessions = useStore.getState().sessions.map(s =>
      (responseSessionId && normalizeSessionId(s.sessionId) === responseSessionId) || s.path === path
        ? { ...s, pinnedAt }
        : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] pin failed:', err);
    showSidebarToast(window.t(pinned ? 'session.pinFailed' : 'session.unpinFailed'));
    return false;
  }
}

/**
 * 提交置顶区的完整新顺序。先按新顺序乐观改写本地 pinOrder（步长与服务端一致），
 * 拖完立刻定位；服务端拒绝或请求失败就整体回滚到提交前的快照并提示，
 * 不留下半套顺序。
 */
export async function reorderPinnedSessions(orderedSessionIds: string[]): Promise<boolean> {
  const sessionIds = Array.isArray(orderedSessionIds)
    ? orderedSessionIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
    : [];
  if (sessionIds.length === 0) return false;

  const snapshot = useStore.getState().sessions;
  const orderById = new Map(sessionIds.map((sessionId, index) => [sessionId, (index + 1) * 1024]));
  useStore.setState({
    sessions: snapshot.map(s => {
      const sessionId = normalizeSessionId(s.sessionId);
      const pinOrder = sessionId ? orderById.get(sessionId) : undefined;
      return pinOrder === undefined ? s : { ...s, pinOrder };
    }),
  });

  try {
    const res = await hanaFetch('/api/sessions/pin-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || res.statusText);
    }
    return true;
  } catch (err) {
    console.error('[session] pin reorder failed:', err);
    useStore.setState({ sessions: snapshot });
    showSidebarToast(window.t('session.reorderFailed'));
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 显式更新会话能力（fresh compact）
// ══════════════════════════════════════════════════════

/**
 * 显式刷新 Agent 工具：fresh compact——旧对话压缩成摘要 checkpoint，
 * 用当前配置重建 prompt/工具快照。成功后重新拉取消息（jsonl 多了 compact 记录）。
 */
export async function refreshSessionCapabilities(path: string): Promise<boolean> {
  const store = useStore.getState();
  if (sessionScopedListIncludes(store as Record<string, any>, store.capabilityRefreshingSessions, path)) return false;
  store.setSessionCapabilityRefreshing(path, true);
  try {
    const res = await hanaFetch('/api/sessions/fresh-compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      // Fresh compact runs an LLM summarization over the whole conversation;
      // long sessions routinely exceed the 30s hanaFetch default. A premature
      // abort here surfaces a false failure while the server keeps compacting.
      timeout: 180_000,
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      const routeError = normalizeSessionRouteError(data);
      throw errorWithCode(routeError.message || res.statusText, routeError.code);
    }
    await loadMessages(path);
    return true;
  } catch (err) {
    console.error('[session] capability refresh failed:', err);
    const state = useStore.getState();
    state.setInlineError?.(path, presentErrorWithLabel(tr('input.refreshAndCompactFailed'), err));
    return false;
  } finally {
    useStore.getState().setSessionCapabilityRefreshing(path, false);
  }
}

// ══════════════════════════════════════════════════════
// Toast
// ══════════════════════════════════════════════════════

export function showSidebarToast(text: string, duration = 3000): void {
  useStore.getState().addToast(text, 'info', duration);
}

function tr(key: string): string {
  return typeof window !== 'undefined' && typeof window.t === 'function'
    ? window.t(key)
    : key;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error');
}

/** 有会话就挂到 transcript 最新一块下面常驻；没有会话可挂靠才退回 toast。 */
function showSessionActionError(labelKey: string, path: string, detail: unknown): void {
  const entry = presentErrorWithLabel(tr(labelKey), detail);
  const state = useStore.getState();
  if (path) {
    state.setInlineError?.(path, entry);
    return;
  }
  state.addToast(entry.text, 'error', 6000, entry.code ? { errorCode: entry.code } : undefined);
}

function showSessionCreationError(detail: unknown): void {
  showSessionActionError('session.createFailed', useStore.getState().currentSessionPath || '', detail);
}

function showSessionSwitchError(targetPath: string, detail: unknown): void {
  const state = useStore.getState();
  showSessionActionError('session.switchFailed', state.currentSessionPath || targetPath || '', detail);
}
