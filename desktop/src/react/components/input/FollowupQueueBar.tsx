import { useState, type DragEvent } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import type { FollowupItem } from '../../stores/followup-queue-slice';
import styles from './InputArea.module.css';

export function FollowupQueueBar({
  items,
  isStreaming,
  onSteer,
  onSend,
  onEdit,
  onDelete,
  onReorder,
  onClear,
  onMultitask,
  multitaskBusy,
}: {
  items: FollowupItem[];
  isStreaming: boolean;
  onSteer: (item: FollowupItem) => void;
  onSend: (item: FollowupItem) => void;
  onEdit: (item: FollowupItem) => void;
  onDelete: (item: FollowupItem) => void;
  onReorder: (id: string, targetIndex: number) => void;
  onClear: () => void;
  onMultitask: () => void;
  multitaskBusy: boolean;
}) {
  const { t } = useI18n();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (items.length === 0) return null;

  const endDrag = () => {
    setDraggingId(null);
    setDropIndex(null);
  };

  const handleDragOver = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setDropIndex(after ? index + 1 : index);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!draggingId || dropIndex === null) return endDrag();
    event.preventDefault();
    const from = items.findIndex((item) => item.id === draggingId);
    // 落点在被拖项之后时，先移除再插入会少掉一个位置。
    const target = from >= 0 && dropIndex > from ? dropIndex - 1 : dropIndex;
    onReorder(draggingId, target);
    endDrag();
  };

  const move = (item: FollowupItem, delta: number) => {
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    onReorder(item.id, index + delta);
  };

  return (
    <div className={styles['followup-queue']} data-testid="followup-queue">
      <div className={styles['followup-queue-header']}>
        <span className={styles['followup-queue-count']}>
          {t('chat.queuedCount', { n: items.length })}
        </span>
        <div className={styles['followup-queue-header-actions']}>
          <button
            type="button"
            className={styles['followup-queue-multitask']}
            disabled={!isStreaming || multitaskBusy}
            onClick={onMultitask}
          >
            {t('chat.startMultitasking')}
          </button>
          <button
            type="button"
            className={styles['followup-queue-icon-btn']}
            title={t('chat.clearQueue')}
            aria-label={t('chat.clearQueue')}
            onClick={onClear}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <ul
        className={styles['followup-queue-list']}
        onDrop={handleDrop}
        onDragOver={(event) => { if (draggingId) event.preventDefault(); }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(null);
        }}
      >
        {items.map((item, index) => {
          const preview = item.text.trim() || (item.attachedFiles[0]?.name ?? t('chat.queuedUntitled'));
          const canSteer = isStreaming && item.agentMentions.length === 0;
          const canSendNow = !isStreaming;
          const isDragging = draggingId === item.id;
          const dropBefore = dropIndex === index && draggingId !== item.id;
          const dropAfter = dropIndex === index + 1 && index === items.length - 1 && draggingId !== item.id;
          const itemClass = [
            styles['followup-queue-item'],
            isDragging ? styles['is-dragging'] : '',
            dropBefore ? styles['drop-before'] : '',
            dropAfter ? styles['drop-after'] : '',
          ].filter(Boolean).join(' ');
          return (
            <li
              key={item.id}
              className={itemClass}
              data-testid="followup-queue-item"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.id);
                setDraggingId(item.id);
              }}
              onDragEnd={endDrag}
              onDragOver={(event) => handleDragOver(event, index)}
            >
              <span className={styles['followup-queue-grip']} aria-hidden="true">
                <svg width="10" height="12" viewBox="0 0 10 14" fill="currentColor">
                  <circle cx="3" cy="2" r="1.2" /><circle cx="7" cy="2" r="1.2" />
                  <circle cx="3" cy="7" r="1.2" /><circle cx="7" cy="7" r="1.2" />
                  <circle cx="3" cy="12" r="1.2" /><circle cx="7" cy="12" r="1.2" />
                </svg>
              </span>
              <span className={styles['followup-queue-text']} title={preview}>{preview}</span>
              <div className={styles['followup-queue-item-actions']}>
                <button
                  type="button"
                  className={styles['followup-queue-steer']}
                  disabled={isStreaming ? !canSteer : !canSendNow}
                  title={isStreaming
                    ? (item.agentMentions.length > 0 ? t('agentReview.interjectionUnavailable') : t('chat.steer'))
                    : t('chat.send')}
                  onClick={() => { if (isStreaming) onSteer(item); else onSend(item); }}
                >
                  {isStreaming ? t('chat.steer') : t('chat.send')}
                </button>
                <button
                  type="button"
                  className={styles['followup-queue-icon-btn']}
                  title={t('chat.moveFollowupUp')}
                  aria-label={t('chat.moveFollowupUp')}
                  disabled={index === 0}
                  onClick={() => move(item, -1)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={styles['followup-queue-icon-btn']}
                  title={t('chat.moveFollowupDown')}
                  aria-label={t('chat.moveFollowupDown')}
                  disabled={index === items.length - 1}
                  onClick={() => move(item, 1)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={styles['followup-queue-icon-btn']}
                  title={t('chat.editFollowup')}
                  aria-label={t('chat.editFollowup')}
                  onClick={() => onEdit(item)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={styles['followup-queue-icon-btn']}
                  title={t('chat.deleteFollowup')}
                  aria-label={t('chat.deleteFollowup')}
                  onClick={() => onDelete(item)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="M6 6l1 14h10l1-14" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
