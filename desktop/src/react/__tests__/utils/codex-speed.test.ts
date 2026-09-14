import { describe, expect, it } from 'vitest';
import { shouldShowCodexSpeedControl } from '../../utils/codex-speed';

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
