import { memo, useEffect, useState } from 'react';
import type { InlineErrorEntry } from '../../stores/streaming-slice';
import styles from './Chat.module.css';

interface Props {
  error: InlineErrorEntry;
}

/**
 * 挂在 transcript 最新一块下面的会话错误。人话常驻；技术细节默认收起。
 * 换一条错误时重新收起，避免旧展开态套到新错误上。
 */
export const TranscriptInlineError = memo(function TranscriptInlineError({ error }: Props) {
  const t = window.t ?? ((key: string) => key);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [error]);
  const hasDetail = !!(error.detail || error.code);

  return (
    <div className={styles.transcriptInlineError} role="alert">
      <div className={styles.transcriptInlineErrorHeadline}>
        <span className={styles.transcriptInlineErrorMark} aria-hidden="true" />
        <span className={styles.transcriptInlineErrorText}>{error.text}</span>
        {hasDetail && (
          <button
            type="button"
            className={styles.transcriptInlineErrorToggle}
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
          >
            {expanded ? t('error.detailHide') : t('error.detailShow')}
          </button>
        )}
      </div>
      {hasDetail && expanded && (
        <div className={styles.transcriptInlineErrorDetail}>
          {error.detail && <p className={styles.transcriptInlineErrorDetailLine}>{error.detail}</p>}
          {error.code && <p className={styles.transcriptInlineErrorDetailCode}>{error.code}</p>}
        </div>
      )}
    </div>
  );
});
