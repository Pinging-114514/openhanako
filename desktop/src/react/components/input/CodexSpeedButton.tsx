import { normalizeCodexServiceTier, type CodexServiceTier } from '../../../../../shared/codex-service-tier.ts';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useCodexServiceTier } from '../../hooks/use-codex-service-tier';
import { useI18n } from '../../hooks/use-i18n';
import { SelectWidget, type SelectOption } from '@/ui';
import styles from './InputArea.module.css';

const SPEED_COPY: Record<CodexServiceTier, { label: string; description: string }> = {
  standard: { label: 'Standard', description: 'Default speed' },
  fast: { label: 'Fast', description: 'Faster, uses more quota' },
  ultrafast: { label: 'Ultrafast', description: 'Fastest available' },
};

export function CodexSpeedButton({ modelId = '' }: { modelId?: string | null }) {
  const { t } = useI18n();
  const speed = useCodexServiceTier(hanaFetch, { modelId: modelId ?? '' });

  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };

  const options: SelectOption[] = speed.options.map((option) => {
    const copy = SPEED_COPY[option];
    return {
      value: option,
      label: tOr(`input.codexSpeed.${option}`, copy.label),
      description: tOr(`input.codexSpeedDesc.${option}`, copy.description),
    };
  });

  const boosted = speed.ready && !speed.downgradeUnconfirmed && speed.tier !== 'standard';
  const speedLabel = tOr('input.codexSpeedLabel', 'Speed');
  const currentLabel = speed.downgradeUnconfirmed
    ? tOr('input.codexSpeedUnconfirmed', 'Saved speed has not been changed yet')
    : options.find((option) => option.value === speed.tier)?.label || SPEED_COPY[speed.tier].label;

  return (
    <SelectWidget
      className={`${styles['thinking-selector']} ${styles['speed-selector']}`}
      options={options}
      value={speed.selectValue}
      onChange={(value) => { void speed.selectTier(normalizeCodexServiceTier(value)); }}
      disabled={speed.saving || speed.loading}
      align="end"
      placement="top"
      offset={4}
      popupMinWidth={200}
      triggerBare
      triggerAriaLabel={speedLabel}
      triggerTitle={`${speedLabel}: ${currentLabel}`}
      triggerClassName={`${styles['thinking-pill']}${boosted ? ` ${styles.active}` : ''}`}
      renderTrigger={() => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5.2 17.2a8.2 8.2 0 1 1 13.6 0" />
          <path d="M12 14.2 16.2 9" />
          <circle cx="12" cy="14.2" r="1.15" fill="currentColor" stroke="none" />
        </svg>
      )}
    />
  );
}
