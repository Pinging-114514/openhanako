import { memo } from 'react';
import styles from './InputArea.module.css';

interface Props {
  slashBusy: string | null;
  slashBusyLabel: string;
  compacting: boolean;
  compactingLabel: string;
  screenshotBusy: boolean;
  screenshotLabel: string;
  screenshotPageLabel?: string | null;
  screenshotProgress?: {
    completedBlocks: number;
    totalBlocks: number;
    currentPage: number;
    totalPages: number;
  } | null;
  modelUnavailableMessage?: string | null;
  slashResult: { text: string; type: 'success' | 'error'; deskDir?: string; filePath?: string } | null;
  onResultClick: (() => void) | undefined;
  loopStatus?: {
    status: string;
    label: string;
  } | null;
  onLoopStop?: () => void;
  onLoopPause?: () => void;
  onLoopResume?: () => void;
}

/** 输入区域上方的状态提示条（slash 执行中 / 压缩中 / 结果）。会话报错不在这里。 */
export const InputStatusBars = memo(function InputStatusBars({
  slashBusy, slashBusyLabel, compacting, compactingLabel,
  screenshotBusy, screenshotLabel, screenshotPageLabel, screenshotProgress,
  modelUnavailableMessage = null, slashResult, onResultClick,
  loopStatus = null, onLoopStop, onLoopPause, onLoopResume,
}: Props) {
  const completedBlocks = screenshotProgress?.completedBlocks ?? 0;
  const totalBlocks = screenshotProgress?.totalBlocks ?? 0;
  const percent = totalBlocks > 0
    ? Math.min(100, Math.max(0, (completedBlocks / totalBlocks) * 100))
    : 0;
  const progressLabel = screenshotPageLabel || screenshotLabel;
  const resultClickable = !!onResultClick;
  const t = window.t ?? ((key: string) => key);

  return (
    <>
      {slashBusy && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{slashBusyLabel}</span>
        </div>
      )}
      {compacting && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{compactingLabel}</span>
        </div>
      )}
      {loopStatus && (
        <div className={`${styles['slash-busy-bar']} ${styles['loop-status-bar']}`}>
          <span className={styles['slash-busy-dot']} />
          <span className={styles['loop-status-text']}>{loopStatus.label}</span>
          <span className={styles['loop-status-actions']}>
            {loopStatus.status === 'paused' ? (
              <button type="button" className={styles['loop-status-button']} onClick={onLoopResume}>
                {t('loop.resume')}
              </button>
            ) : (
              <button type="button" className={styles['loop-status-button']} onClick={onLoopPause}>
                {t('loop.pause')}
              </button>
            )}
            <button type="button" className={styles['loop-status-button']} onClick={onLoopStop}>
              {t('loop.stop')}
            </button>
          </span>
        </div>
      )}
      {screenshotBusy && (
        <div className={`${styles['slash-busy-bar']} ${styles['screenshot-busy-bar']}`}>
          <div className={styles['screenshot-busy-label']}>
            <span className={styles['slash-busy-dot']} />
            <span>{progressLabel}</span>
          </div>
          <div
            className={styles['screenshot-progress-track']}
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={totalBlocks || 1}
            aria-valuenow={Math.min(completedBlocks, totalBlocks || completedBlocks)}
          >
            <span
              className={styles['screenshot-progress-fill']}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}
      {modelUnavailableMessage && (
        <div className={styles['slash-error-bar']} role="status">
          <span className={styles['slash-error-dot']} />
          <span>{modelUnavailableMessage}</span>
        </div>
      )}
      {!slashBusy && !compacting && !screenshotBusy && !modelUnavailableMessage && slashResult && (
        <div
          className={`${styles['slash-busy-bar']}${resultClickable ? ` ${styles['slash-busy-bar-clickable']}` : ''}`}
          onClick={onResultClick}
          onKeyDown={resultClickable ? (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onResultClick();
          } : undefined}
          role={resultClickable ? 'button' : undefined}
          tabIndex={resultClickable ? 0 : undefined}
        >
          <span className={styles[slashResult.type === 'success' ? 'slash-result-dot-ok' : 'slash-result-dot-err']} />
          <span>{slashResult.text}</span>
        </div>
      )}
    </>
  );
});
