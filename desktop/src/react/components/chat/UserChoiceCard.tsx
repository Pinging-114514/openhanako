/**
 * UserChoiceCard — ask_user 对话内选方案卡
 *
 * 单选 / 多选由 allowMultiple 决定。UI 自动加「其他…」。
 */

import { memo, useCallback, useMemo, useState } from 'react';
import styles from './Chat.module.css';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';

const OTHER_ID = '__other__';

export type UserChoiceOption = {
  id: string;
  label: string;
  description?: string;
};

export type UserChoiceAnswer = {
  selected: string[];
  free_text?: string;
  skipped?: true;
};

type Props = {
  confirmId?: string;
  question: string;
  options?: UserChoiceOption[];
  allowMultiple?: boolean;
  status?: 'pending' | 'answered' | 'skipped' | 'timeout';
  answer?: UserChoiceAnswer | null;
};

export const UserChoiceCard = memo(function UserChoiceCard(props: Props) {
  const {
    confirmId,
    question,
    options = [],
    allowMultiple = false,
    status: propStatus = 'pending',
    answer: propAnswer = null,
  } = props;
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [otherOn, setOtherOn] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [local, setLocal] = useState<{ status: Props['status']; answer?: UserChoiceAnswer | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const status = propStatus !== 'pending' ? propStatus : (local?.status ?? 'pending');
  const answer = propStatus !== 'pending' ? propAnswer : (local?.answer ?? propAnswer);

  const canSubmit = selectedIds.length > 0 || (otherOn && otherText.trim().length > 0);

  const toggleOption = useCallback((id: string) => {
    if (id === OTHER_ID) {
      if (allowMultiple) {
        setOtherOn((on) => !on);
        return;
      }
      setOtherOn(true);
      setSelectedIds([]);
      return;
    }
    if (allowMultiple) {
      setSelectedIds((current) => (
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      ));
      return;
    }
    setOtherOn(false);
    setSelectedIds([id]);
  }, [allowMultiple]);

  const buildValue = useCallback((): UserChoiceAnswer => ({
    selected: selectedIds,
    ...(otherOn && otherText.trim() ? { free_text: otherText.trim() } : {}),
  }), [otherOn, otherText, selectedIds]);

  const handleConfirm = useCallback(async () => {
    if (!confirmId || !canSubmit || submitting) return;
    const value = buildValue();
    setSubmitting(true);
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmed', value }),
      });
      setLocal({ status: 'answered', answer: value });
    } catch { /* silent */ } finally {
      setSubmitting(false);
    }
  }, [buildValue, canSubmit, confirmId, submitting]);

  const handleSkip = useCallback(async () => {
    if (!confirmId || submitting) return;
    const skipped: UserChoiceAnswer = { selected: [], skipped: true };
    setSubmitting(true);
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rejected', value: skipped }),
      });
      setLocal({ status: 'skipped', answer: skipped });
    } catch { /* silent */ } finally {
      setSubmitting(false);
    }
  }, [confirmId, submitting]);

  const chosenLabels = useMemo(() => {
    if (!answer) return [];
    const labels = (answer.selected || [])
      .map((id) => options.find((option) => option.id === id)?.label || id)
      .filter(Boolean);
    if (answer.free_text) labels.push(answer.free_text);
    return labels;
  }, [answer, options]);

  if (status !== 'pending') {
    const statusText = status === 'answered'
      ? (chosenLabels.length ? chosenLabels.join(' · ') : t('chat.askUser.answered'))
      : status === 'timeout'
        ? t('chat.askUser.timeout')
        : t('chat.askUser.skipped');
    return (
      <div className={`${styles.settingsConfirmCard} ${styles.settingsConfirmCardDone} ${styles.userChoiceCard}`}>
        <div className={styles.userChoiceQuestion}>{question}</div>
        <div className={`${styles.settingsConfirmStatus} ${status === 'answered' ? styles.settingsConfirmStatusConfirmed : ''}`}>
          <span>{statusText}</span>
          {status === 'answered' ? (
            <svg className={styles.settingsConfirmIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg className={styles.settingsConfirmIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.settingsConfirmCard} ${styles.userChoiceCard}`}>
      <div className={styles.userChoiceQuestion}>{question}</div>
      <div className={styles.userChoiceHint}>
        {allowMultiple ? t('chat.askUser.hintMultiple') : t('chat.askUser.hintSingle')}
      </div>
      <div
        className={`${styles.settingsConfirmControl} ${styles.settingsConfirmOptions}`}
        role={allowMultiple ? 'group' : 'radiogroup'}
        aria-label={question}
      >
        {options.map((option) => {
          const selected = selectedIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              role={allowMultiple ? 'checkbox' : 'radio'}
              aria-checked={selected}
              className={`${styles.settingsConfirmOption} ${styles.userChoiceOption}${selected ? ` ${styles.settingsConfirmOptionSelected}` : ''}`}
              onClick={() => toggleOption(option.id)}
            >
              <span className={styles.userChoiceOptionText}>
                <span className={styles.userChoiceOptionLabel}>{option.label}</span>
                {option.description ? (
                  <span className={styles.userChoiceOptionDesc}>{option.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          role={allowMultiple ? 'checkbox' : 'radio'}
          aria-checked={otherOn}
          className={`${styles.settingsConfirmOption} ${styles.userChoiceOption}${otherOn ? ` ${styles.settingsConfirmOptionSelected}` : ''}`}
          onClick={() => toggleOption(OTHER_ID)}
        >
          <span className={styles.userChoiceOptionLabel}>{t('chat.askUser.other')}</span>
        </button>
      </div>
      {otherOn ? (
        <input
          className={`${styles.settingsConfirmInput} ${styles.userChoiceOtherInput}`}
          type="text"
          value={otherText}
          onChange={(event) => setOtherText(event.target.value)}
          placeholder={t('chat.askUser.otherPlaceholder')}
        />
      ) : null}
      <div className={styles.settingsConfirmActions}>
        <button
          type="button"
          className={`${styles.settingsConfirmBtn} ${styles.settingsConfirmBtnConfirm}`}
          onClick={handleConfirm}
          disabled={!canSubmit || submitting}
        >
          {t('chat.askUser.confirm')}
        </button>
        <button
          type="button"
          className={`${styles.settingsConfirmBtn} ${styles.settingsConfirmBtnReject}`}
          onClick={handleSkip}
          disabled={submitting}
        >
          {t('chat.askUser.skip')}
        </button>
      </div>
    </div>
  );
});
