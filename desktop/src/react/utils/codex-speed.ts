import {
  availableCodexServiceTiers,
  isCodexOauthProvider,
  normalizeCodexServiceTier,
  resolveCodexServiceTier,
  type CodexServiceTier,
} from '../../../../shared/codex-service-tier.ts';

export function shouldShowCodexSpeedControl(
  sessionModel?: { provider?: string; id?: string } | null,
  models: readonly { provider?: string; id?: string; isCurrent?: boolean }[] = [],
): boolean {
  const current = sessionModel?.id || sessionModel?.provider
    ? sessionModel
    : models.find((model) => model.isCurrent);
  if (isCodexOauthProvider(current?.provider)) return true;
  if (!current?.id) return false;
  const matched = models.find((model) => (
    model.id === current.id
    && (!current.provider || !model.provider || model.provider === current.provider)
  ));
  return isCodexOauthProvider(matched?.provider);
}

export function visibleCodexSpeedTiers(eligible: boolean, modelId?: unknown): CodexServiceTier[] {
  return [...availableCodexServiceTiers(eligible === true, modelId)];
}

export function resolveVisibleCodexTier(
  tier: unknown,
  eligible: boolean,
  modelId?: unknown,
): CodexServiceTier {
  return resolveCodexServiceTier(tier, eligible === true, modelId);
}

export type CodexTierPayload = {
  valid: boolean;
  tier: CodexServiceTier;
  preferredTier: CodexServiceTier | null;
  ultrafastEligible: boolean;
  needsLegacyDowngrade: boolean;
};

export function interpretCodexTierPayload(data: unknown): CodexTierPayload {
  const invalid: CodexTierPayload = {
    valid: false,
    tier: 'standard',
    preferredTier: null,
    ultrafastEligible: false,
    needsLegacyDowngrade: false,
  };
  if (!data || typeof data !== 'object') return invalid;
  const record = data as Record<string, unknown>;
  if (typeof record.tier !== 'string' || !record.tier.trim()) return invalid;
  const ultrafastEligible = record.ultrafastEligible === true;
  const tier = normalizeCodexServiceTier(record.tier);
  const preferredTier = typeof record.preferredTier === 'string' && record.preferredTier.trim()
    ? normalizeCodexServiceTier(record.preferredTier)
    : null;
  return {
    valid: true,
    tier,
    preferredTier,
    ultrafastEligible,
    needsLegacyDowngrade: tier === 'ultrafast' && !ultrafastEligible,
  };
}
