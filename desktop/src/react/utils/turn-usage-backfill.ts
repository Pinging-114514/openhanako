import { summarizeTurnUsage } from '../../../../lib/llm/turn-usage.ts';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import type { ChatMessage, SessionMessages } from '../stores/chat-types';

const inflight = new Set<string>();

function previousUserTimestamp(sessionPath: string, messageId: string): number | null {
  const state = useStore.getState();
  const session = sessionScopedValue<SessionMessages>(state as any, state.chatSessions, sessionPath);
  const items = session?.items;
  if (!items?.length) return null;
  const idx = items.findIndex((item) => item.type === 'message' && item.data.id === messageId);
  const from = idx >= 0 ? idx : items.length;
  for (let i = from - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message' && item.data.role === 'user') {
      const ts = item.data.timestamp;
      return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
    }
  }
  return null;
}

export async function fetchTurnUsageForMessage(
  sessionPath: string,
  messageId?: string | null,
  timestamp?: number | null,
): Promise<ChatMessage['turnUsage'] | null> {
  const userStartedAt = messageId ? previousUserTimestamp(sessionPath, messageId) : null;
  const sinceMs = userStartedAt
    ?? (timestamp && Number.isFinite(timestamp) ? Math.max(0, timestamp - 30 * 60_000) : 0);
  const params = new URLSearchParams({
    sessionPath,
    subsystem: 'session',
    operation: 'reply',
    limit: '200',
  });
  if (sinceMs) params.set('since', new Date(sinceMs).toISOString());
  const res = await hanaFetch(`/api/usage/llm?${params.toString()}`);
  if (!res.ok) return null;
  const data = await res.json() as { entries?: unknown[] };
  return summarizeTurnUsage(data?.entries || [], {
    startedAt: sinceMs || null,
    endedAt: Date.now(),
  });
}

function isRicherUsage(next: ChatMessage['turnUsage'], current: ChatMessage['turnUsage']): boolean {
  if (!next) return false;
  if (!current) return true;
  const nextCalls = Number(next.calls) || 0;
  const currentCalls = Number(current.calls) || 0;
  if (nextCalls !== currentCalls) return nextCalls > currentCalls;
  return (Number(next.output) || 0) > (Number(current.output) || 0);
}

export function scheduleTurnUsageBackfill(
  sessionPath: string | null | undefined,
  messageId: string | null | undefined,
  timestamp?: number | null,
): void {
  if (!sessionPath || !messageId) return;
  const key = `${sessionPath}::${messageId}`;
  if (inflight.has(key)) return;
  inflight.add(key);
  void fetchTurnUsageForMessage(sessionPath, messageId, timestamp)
    .then((usage) => {
      if (!usage) return;
      useStore.getState().updateMessageById(sessionPath, messageId, (msg) => (
        isRicherUsage(usage, msg.turnUsage) ? { ...msg, turnUsage: usage } : msg
      ));
    })
    .catch(() => {
      // Footer backfill must never break the transcript.
    })
    .finally(() => {
      inflight.delete(key);
    });
}
