import { useStore } from '../stores';
import { isUnpersistedOptimisticUserItem } from '../stores/chat-slice';
import type { ChatMessage } from '../stores/chat-types';
import type { AttachedFile } from '../stores/input-slice';
import { sessionScopedValue } from '../stores/session-slice';

export const OPTIMISTIC_USER_SEND_TIMEOUT_MS = 20_000;

const watches = new Map<string, number>();

function watchKey(sessionPath: string, clientMessageId: string): string {
  return `${sessionPath}::${clientMessageId}`;
}

export function watchOptimisticUserSend(sessionPath: string, clientMessageId: string): void {
  clearOptimisticUserSendWatch(sessionPath, clientMessageId);
  if (typeof window === 'undefined') return;
  const key = watchKey(sessionPath, clientMessageId);
  const timer = window.setTimeout(() => {
    watches.delete(key);
    const session = sessionScopedValue(useStore.getState(), useStore.getState().chatSessions, sessionPath);
    const pending = (session?.items || []).some((item) => (
      item.type === 'message'
      && item.data.role === 'user'
      && item.data.id === clientMessageId
      && item.data.sendStatus === 'pending'
      && !item.data.sourceEntryId
    ));
    if (!pending) return;
    useStore.getState().markOptimisticUserMessageFailed(sessionPath, clientMessageId, 'send_timeout');
  }, OPTIMISTIC_USER_SEND_TIMEOUT_MS);
  watches.set(key, timer);
}

export function resetOptimisticUserSendWatchesForTest(): void {
  for (const timer of watches.values()) {
    if (typeof window !== 'undefined') window.clearTimeout(timer);
  }
  watches.clear();
}

export function clearOptimisticUserSendWatch(sessionPath: string, clientMessageId: string): void {
  const key = watchKey(sessionPath, clientMessageId);
  const timer = watches.get(key);
  if (timer == null) return;
  if (typeof window !== 'undefined') window.clearTimeout(timer);
  watches.delete(key);
}

export function failPendingOptimisticSends(sessionPath: string, error: string): string[] {
  const ids = useStore.getState().failPendingOptimisticUserMessages(sessionPath, error);
  for (const id of ids) clearOptimisticUserSendWatch(sessionPath, id);
  return ids;
}

export function listUnpersistedOptimisticUserMessages(sessionPath: string): ChatMessage[] {
  const session = sessionScopedValue(useStore.getState(), useStore.getState().chatSessions, sessionPath);
  return (session?.items || [])
    .filter(isUnpersistedOptimisticUserItem)
    .map((item) => item.data);
}

function attachmentKey(file: { fileId?: string; path?: string; name?: string }): string {
  return file.fileId || file.path || file.name || '';
}

export function mergeUnpersistedOptimisticIntoSend(opts: {
  text: string;
  files: AttachedFile[];
  leftover: ChatMessage[];
}): { text: string; files: AttachedFile[]; consumedIds: string[] } {
  const seen = new Set(opts.files.map(attachmentKey).filter(Boolean));
  const files = [...opts.files];
  const textParts: string[] = [];
  const consumedIds: string[] = [];
  const currentText = opts.text.trim();

  for (const message of opts.leftover) {
    consumedIds.push(message.id);
    const extra = (message.text || '').trim();
    if (extra && extra !== currentText && !currentText.includes(extra)) {
      textParts.push(extra);
    }
    for (const attachment of message.attachments || []) {
      const key = attachmentKey(attachment);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      files.push({
        fileId: attachment.fileId,
        path: attachment.path,
        name: attachment.name,
        isDirectory: !!attachment.isDir,
        mimeType: attachment.mimeType,
        base64Data: attachment.base64Data,
        waveform: attachment.waveform,
      });
    }
  }

  return {
    text: textParts.length ? `${textParts.join('\n\n')}\n\n${opts.text}`.trim() : opts.text,
    files,
    consumedIds,
  };
}
