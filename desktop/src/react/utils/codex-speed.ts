import { isCodexOauthProvider } from '../../../../shared/codex-service-tier.ts';

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
