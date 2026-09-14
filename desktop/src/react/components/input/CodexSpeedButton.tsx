import { useCallback, useEffect, useState } from 'react';
import {
  CODEX_SERVICE_TIERS,
  DEFAULT_CODEX_SERVICE_TIER,
  normalizeCodexServiceTier,
  type CodexServiceTier,
} from '../../../../../shared/codex-service-tier.ts';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { SelectWidget, type SelectOption } from '@/ui';
import styles from './InputArea.module.css';

const SPEED_COPY: Record<CodexServiceTier, { label: string; description: string }> = {
  standard: { label: 'Standard', description: 'Default speed' },
  fast: { label: 'Fast', description: '1.5x speed, more usage' },
  ultrafast: { label: 'Ultrafast', description: 'Fastest available' },
};

export function CodexSpeedButton() {
  const { t } = useI18n();
  const [tier, setTier] = useState<CodexServiceTier>(DEFAULT_CODEX_SERVICE_TIER);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hanaFetch('/api/preferences/codex-service-tier')
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setTier(normalizeCodexServiceTier(data?.tier));
        setAvailable(true);
      })
      .catch(() => {
        // Keep the control visible even if an older server lacks the route.
        if (!cancelled) setAvailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectTier = useCallback(async (next: CodexServiceTier) => {
    if (next === tier || saving) return;
    setSaving(true);
    try {
      const res = await hanaFetch('/api/preferences/codex-service-tier', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: next }),
      });
      const data = await res.json();
      setTier(normalizeCodexServiceTier(data?.tier || next));
    } catch (err) {
      console.error('[codex-speed] save failed:', err);
    } finally {
      setSaving(false);
    }
  }, [saving, tier]);

  if (available === false) return null;

  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };

  const options: SelectOption[] = CODEX_SERVICE_TIERS.map((option) => {
    const copy = SPEED_COPY[option];
    return {
      value: option,
      label: tOr(`input.codexSpeed.${option}`, copy.label),
      description: tOr(`input.codexSpeedDesc.${option}`, copy.description),
    };
  });

  const boosted = tier !== 'standard';
  const speedLabel = tOr('input.codexSpeedLabel', 'Speed');
  const currentLabel = options.find((option) => option.value === tier)?.label || SPEED_COPY[tier].label;

  return (
    <SelectWidget
      className={`${styles['thinking-selector']} ${styles['speed-selector']}`}
      options={options}
      value={tier}
      onChange={(value) => selectTier(normalizeCodexServiceTier(value))}
      disabled={saving || available !== true}
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
