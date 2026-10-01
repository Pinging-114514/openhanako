import { sessionIdForPathFromLocatorState, sessionScopedKey, sessionScopedListIncludes } from './session-slice';
import { isSessionCompacting } from './context-slice';
import type { JSONContent } from '@tiptap/core';
import type { AttachedFile, QuotedSelection } from './input-slice';

export const FOLLOWUP_QUEUE_STORAGE_KEY = 'hana-followup-queue';

function persistEnabled(): boolean {
  return typeof window !== 'undefined'
    && typeof localStorage !== 'undefined'
    && process.env.VITEST !== 'true';
}

function persistableItem(item: FollowupItem): FollowupItem {
  return {
    ...item,
    attachedFiles: (item.attachedFiles || []).map((file) => {
      const next = { ...file };
      delete next.base64Data;
      return next;
    }),
  };
}

export function readPersistedFollowups(): Record<string, FollowupItem[]> {
  if (!persistEnabled()) return {};
  try {
    const raw = window.localStorage.getItem(FOLLOWUP_QUEUE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: Record<string, FollowupItem[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !Array.isArray(value)) continue;
      next[key] = value.filter((item): item is FollowupItem => !!item && typeof item === 'object' && typeof (item as FollowupItem).id === 'string');
    }
    return next;
  } catch {
    return {};
  }
}

export function writePersistedFollowups(followupsBySession: Record<string, FollowupItem[]>): void {
  if (!persistEnabled()) return;
  try {
    const compact: Record<string, FollowupItem[]> = {};
    for (const [key, items] of Object.entries(followupsBySession || {})) {
      if (!key || !items?.length) continue;
      compact[key] = items.map(persistableItem);
    }
    window.localStorage.setItem(FOLLOWUP_QUEUE_STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // localStorage 不可用时排队只活在当前窗口。
  }
}

export function followupSessionAliases(state: any, token: string): string[] {
  const path = locatorPath(state, token);
  const key = queueKey(state, path);
  return [token, path, key].filter((value, index, all): value is string => (
    typeof value === 'string' && !!value && all.indexOf(value) === index
  ));
}

/** Queue ownership must never fall back to an unrelated focused session. */
export function resolveFollowupSessionRef(state: any, token: string): Readonly<{ sessionId: string; sessionPath: string; agentId: string }> | null {
  if (!token) return null;
  const sessionPath = locatorPath(state, token);
  const sessionId = sessionIdForPathFromLocatorState(state, sessionPath);
  if (!sessionId || !sessionPath) return null;
  const locator = state?.sessionLocatorsById?.[sessionId];
  if (locator && locator.path !== sessionPath) return null;
  const projection = (state.sessions || []).find((session: any) => session?.path === sessionPath);
  const ownsFocus = state.currentSessionId === sessionId && state.currentSessionPath === sessionPath;
  const agentId = projection?.agentId || (ownsFocus ? state.currentAgentId : null);
  if (!agentId || projection?.agentDeleted) return null;
  return Object.freeze({ sessionId, sessionPath, agentId });
}

/** Per-item claim shared by automatic flush and manual send. Owner path is part of the key so two sessions may reuse an item id. */
export function followupSendClaimKey(owner: { sessionId: string; sessionPath: string }, itemId: string): string {
  return `${owner.sessionId}\0${owner.sessionPath}\0${itemId}`;
}

export function findFollowupItem(state: any, token: string, itemId: string): FollowupItem | null {
  if (!itemId) return null;
  const queues = state?.followupsBySession || {};
  const seen = new Set<string>();
  const tokens = [token, ...followupSessionAliases(state, token)];
  for (const alias of tokens) {
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    const found = (queues[alias] || []).find((item: FollowupItem) => item?.id === itemId);
    if (found) return found;
  }
  return null;
}

export function isFollowupFlushBlocked(state: any, token: string): boolean {
  return followupSessionAliases(state, token).some((item) => (
    sessionScopedListIncludes(state, state.streamingSessions, item)
    || sessionScopedListIncludes(state, state.capabilityRefreshingSessions, item)
    || isSessionCompacting(state, item)
  ));
}

export interface FollowupAgentMention {
  agentId: string;
  label: string;
}

export interface FollowupSessionRef {
  sessionId?: string;
  sessionPath?: string;
  label?: string;
}

export interface FollowupItem {
  id: string;
  createdAt: number;
  /** Content generation. Identity stays on id; updates bump this so an in-flight send can see the item changed. */
  revision?: number;
  text: string;
  editorJson: JSONContent;
  skills: string[];
  sessionRefs: FollowupSessionRef[];
  agentMentions: FollowupAgentMention[];
  attachedFiles: AttachedFile[];
  quotes: QuotedSelection[];
  docContextAttached: boolean;
  doc: { path: string; name: string } | null;
}

export interface FollowupQueueSlice {
  followupsBySession: Record<string, FollowupItem[]>;
  enqueueFollowup: (sessionPath: string, item: Omit<FollowupItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) => FollowupItem;
  updateFollowup: (sessionPath: string, id: string, patch: Partial<FollowupItem>) => void;
  removeFollowup: (sessionPath: string, id: string) => FollowupItem | null;
  /** 把 id 移到 targetIndex（拖拽落点）。越界会夹到两端。 */
  reorderFollowup: (sessionPath: string, id: string, targetIndex: number) => void;
  clearFollowups: (sessionPath: string) => void;
  peekFollowup: (sessionPath: string) => FollowupItem | null;
}

function queueKey(state: any, sessionPath: string): string {
  return sessionScopedKey(state, sessionPath) || sessionPath;
}

function locatorPath(state: any, token: string): string {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  if (sessions.some((session: any) => session?.path === token)) return token;
  const byId = sessions.find((session: any) => session?.sessionId === token);
  if (byId?.path) return byId.path;
  const locatorPathValue = state?.sessionLocatorsById?.[token]?.path;
  if (typeof locatorPathValue === 'string' && locatorPathValue) return locatorPathValue;
  if (state?.currentSessionId === token && typeof state?.currentSessionPath === 'string') {
    return state.currentSessionPath;
  }
  return token;
}

function listFor(state: FollowupQueueSlice, key: string, sessionPath: string): FollowupItem[] {
  return state.followupsBySession[key] || state.followupsBySession[sessionPath] || [];
}

export function createFollowupQueueSlice(
  set: (partial: Partial<FollowupQueueSlice> | ((s: FollowupQueueSlice) => Partial<FollowupQueueSlice>)) => void,
  get: () => FollowupQueueSlice,
): FollowupQueueSlice {
  return {
    followupsBySession: readPersistedFollowups(),
    enqueueFollowup: (sessionPath, draft) => {
      const item: FollowupItem = {
        id: draft.id || (globalThis.crypto?.randomUUID?.() ?? `followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        createdAt: draft.createdAt || Date.now(),
        text: draft.text || '',
        editorJson: draft.editorJson,
        skills: draft.skills || [],
        sessionRefs: draft.sessionRefs || [],
        agentMentions: draft.agentMentions || [],
        attachedFiles: (draft.attachedFiles || []).map((file) => ({ ...file })),
        quotes: (draft.quotes || []).map((quote) => ({ ...quote })),
        docContextAttached: !!draft.docContextAttached,
        doc: draft.doc ? { ...draft.doc } : null,
        revision: typeof draft.revision === 'number' && Number.isFinite(draft.revision) ? draft.revision : 0,
      };
      set((s) => {
        const key = queueKey(s, sessionPath);
        const next = { ...s.followupsBySession, [key]: [...listFor(s, key, sessionPath), item] };
        if (key !== sessionPath) delete next[sessionPath];
        return { followupsBySession: next };
      });
      return item;
    },
    updateFollowup: (sessionPath, id, patch) => set((s) => {
      const key = queueKey(s, sessionPath);
      const current = listFor(s, key, sessionPath);
      const nextItems = current.map((item) => (item.id === id
        ? { ...item, ...patch, id: item.id, revision: (item.revision ?? 0) + 1 }
        : item));
      const next = { ...s.followupsBySession, [key]: nextItems };
      if (key !== sessionPath) delete next[sessionPath];
      return { followupsBySession: next };
    }),
    removeFollowup: (sessionPath, id) => {
      let removed: FollowupItem | null = null;
      set((s) => {
        const ownerPath = locatorPath(s, sessionPath);
        const key = queueKey(s, ownerPath);
        const current = listFor(s, key, ownerPath);
        const nextItems = current.filter((item) => {
          if (item.id !== id) return true;
          removed = item;
          return false;
        });
        const next = { ...s.followupsBySession };
        if (nextItems.length) next[key] = nextItems;
        else delete next[key];
        if (key !== ownerPath) delete next[ownerPath];
        return { followupsBySession: next };
      });
      return removed;
    },
    reorderFollowup: (sessionPath, id, targetIndex) => set((s) => {
      const key = queueKey(s, sessionPath);
      const current = listFor(s, key, sessionPath);
      const from = current.findIndex((item) => item.id === id);
      if (from < 0) return {};
      const to = Math.max(0, Math.min(current.length - 1, targetIndex));
      if (from === to) return {};
      const nextItems = [...current];
      const [moved] = nextItems.splice(from, 1);
      nextItems.splice(to, 0, moved);
      const next = { ...s.followupsBySession, [key]: nextItems };
      if (key !== sessionPath) delete next[sessionPath];
      return { followupsBySession: next };
    }),
    clearFollowups: (sessionPath) => set((s) => {
      const key = queueKey(s, sessionPath);
      const next = { ...s.followupsBySession };
      delete next[key];
      if (key !== sessionPath) delete next[sessionPath];
      return { followupsBySession: next };
    }),
    peekFollowup: (sessionPath) => {
      const state = get();
      const path = locatorPath(state, sessionPath);
      const key = queueKey(state, path);
      return listFor(state, key, path)[0]
        || state.followupsBySession[sessionPath]?.[0]
        || null;
    },
  };
}
