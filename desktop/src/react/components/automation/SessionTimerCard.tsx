import { useStore } from '../../stores';
import { switchSession } from '../../stores/session-actions';
import type { CronJob } from './automation-types';
import { scheduleDraftFromStored, schedulePreviewFromDraft } from './schedule-draft';
import styles from './AutomationPanel.module.css';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function jobTitle(job: CronJob) {
  return job.label || job.prompt?.slice(0, 40) || job.id;
}

export function SessionTimerCard({
  job,
  open,
  onToggleOpen,
  onToggleEnabled,
  onRemove,
  onClose,
}: {
  job: CronJob;
  open: boolean;
  onToggleOpen: () => void;
  onToggleEnabled: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const t = window.t ?? ((key: string) => key);
  const sessions = useStore(s => s.sessions);
  const sourceSessionId = job.executionContext?.sourceSessionId || '';
  const session = sessions.find(item => item.sessionId === sourceSessionId) || null;
  const sessionTitle = session?.title?.trim() || t('automation.unknownSession');
  const schedule = schedulePreviewFromDraft(scheduleDraftFromStored(job.type, job.schedule));

  const openSession = () => {
    if (!session?.path) return;
    void switchSession(session.path);
    onClose();
  };

  return (
    <div className={styles.card}>
      <button type="button" className={styles.row} onClick={onToggleOpen} aria-expanded={open}>
        <span
          className={`hana-toggle${job.enabled ? ' on' : ''}`}
          title={job.enabled ? t('automation.disable') : t('automation.enable')}
          onClick={(event) => {
            event.stopPropagation();
            onToggleEnabled(job.id);
          }}
        />
        <span className={styles.rowMain}>
          <span className={styles.title} title={jobTitle(job)}>{jobTitle(job)}</span>
          <span className={styles.subline}>
            <span className={styles.meta}>{schedule}</span>
            <span className={styles.meta} title={sessionTitle}>{sessionTitle}</span>
            {job.nextRunAt ? <span className={styles.meta}>{new Date(job.nextRunAt).toLocaleString(undefined, { hour12: false })}</span> : null}
          </span>
        </span>
        <span className={styles.meta}>{job.enabled ? t('common.on') : t('common.off')}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className={styles.details}>
          <div className={styles.field}>
            <span>{t('automation.session')}</span>
            <button className={styles.textButton} type="button" disabled={!session?.path} onClick={openSession}>
              {sessionTitle}
            </button>
          </div>
          {job.prompt ? (
            <div className={styles.field}>
              <span>{t('automation.field.prompt')}</span>
              <p className={styles.promptRead}>{job.prompt}</p>
            </div>
          ) : null}
          <div className={styles.actions}>
            <button className={`${styles.textButton} ${styles.dangerButton}`} type="button" onClick={() => onRemove(job.id)}>
              {t('automation.delete')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
