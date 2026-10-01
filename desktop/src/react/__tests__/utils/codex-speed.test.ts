import { describe, expect, it } from 'vitest';
import { supportsCodexUltrafastModel } from '../../../../../shared/codex-service-tier.ts';
import {
  interpretCodexTierPayload,
  resolveVisibleCodexTier,
  shouldShowCodexSpeedControl,
  visibleCodexSpeedTiers,
} from '../../utils/codex-speed';

describe('shouldShowCodexSpeedControl', () => {
  it('shows the control for the current Codex OAuth model', () => {
    expect(shouldShowCodexSpeedControl(undefined, [
      { provider: 'openai-codex-oauth', isCurrent: true },
    ])).toBe(true);
    expect(shouldShowCodexSpeedControl({ provider: 'openai-codex' })).toBe(true);
  });

  it('hides the control for other providers and empty selection', () => {
    expect(shouldShowCodexSpeedControl(undefined, [
      { provider: 'xai-oauth', isCurrent: true },
    ])).toBe(false);
    expect(shouldShowCodexSpeedControl({ provider: 'openai' })).toBe(false);
    expect(shouldShowCodexSpeedControl(undefined, [])).toBe(false);
  });

  it('prefers the session model over the global current model', () => {
    expect(shouldShowCodexSpeedControl(
      { provider: 'xai-oauth' },
      [{ provider: 'openai-codex-oauth', isCurrent: true }],
    )).toBe(false);
  });
});

describe('codex ultrafast visibility', () => {
  it('keeps ultrafast off the global list unless eligibility is explicit', () => {
    expect(visibleCodexSpeedTiers(false)).toEqual(['standard', 'fast']);
    expect(visibleCodexSpeedTiers(true)).toEqual(['standard', 'fast', 'ultrafast']);
    expect(interpretCodexTierPayload({
      tier: 'ultrafast',
      options: ['standard', 'fast', 'ultrafast'],
    }).needsLegacyDowngrade).toBe(true);
    expect(interpretCodexTierPayload({
      tier: 'fast',
      preferredTier: 'ultrafast',
      ultrafastEligible: false,
    }).needsLegacyDowngrade).toBe(false);
    expect(interpretCodexTierPayload({ sessionId: 'nope' }).valid).toBe(false);
  });

  it('allows Astra snapshots and refuses Sol even on an eligible account', () => {
    expect(supportsCodexUltrafastModel(undefined)).toBe(false);
    expect(supportsCodexUltrafastModel('')).toBe(false);
    expect(supportsCodexUltrafastModel('openai/GPT-6-Astra')).toBe(true);
    expect(supportsCodexUltrafastModel('gpt-6-astra-2026-09-30')).toBe(true);
    expect(supportsCodexUltrafastModel('gpt-6-astra-20260930')).toBe(false);
    expect(supportsCodexUltrafastModel(null)).toBe(false);
    expect(supportsCodexUltrafastModel('gpt-6.1-sol')).toBe(false);
    expect(supportsCodexUltrafastModel('gpt-6-sol')).toBe(false);
    expect(visibleCodexSpeedTiers(true)).toEqual(['standard', 'fast', 'ultrafast']);
    expect(visibleCodexSpeedTiers(true, '')).toEqual(['standard', 'fast']);
    expect(visibleCodexSpeedTiers(true, 'gpt-6.1-sol')).toEqual(['standard', 'fast']);
    expect(resolveVisibleCodexTier('ultrafast', true, 'gpt-6.1-sol')).toBe('fast');
    expect(resolveVisibleCodexTier('ultrafast', true, 'openai/gpt-6-astra')).toBe('ultrafast');
    expect(resolveVisibleCodexTier('ultrafast', false)).toBe('fast');
  });
});
