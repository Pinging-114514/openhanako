import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export function SendButton({ isStreaming, hasInput, disabled, onSend, onQueue, onStop }: {
  isStreaming: boolean;
  hasInput: boolean;
  disabled: boolean;
  onSend: () => void;
  onQueue: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();

  // 默认排队：流式中有内容入队，空输入才是停止。插话在队列条目上。
  const mode = isStreaming ? (hasInput ? 'queue' : 'stop') : 'send';

  return (
    <button
      className={`${styles['send-btn']}${mode === 'queue' ? ` ${styles['is-queue']}` : mode === 'stop' ? ` ${styles['is-streaming']}` : ''}`}
      disabled={disabled}
      onClick={mode === 'queue' ? onQueue : mode === 'stop' ? onStop : onSend}
    >
      {mode === 'send' && (
        <span className={styles['send-label']}>
          <svg className={styles['send-enter-icon']} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span>{t('chat.send')}</span>
        </span>
      )}
      {mode === 'queue' && (
        <span className={styles['send-label']}>
          <svg className={styles['send-enter-icon']} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
          <span>{t('chat.queue')}</span>
        </span>
      )}
      {mode === 'stop' && (
        <span className={styles['send-label']}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span>{t('chat.stop')}</span>
        </span>
      )}
    </button>
  );
}
