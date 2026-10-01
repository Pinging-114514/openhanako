import { describe, expect, it } from 'vitest';
import { createModelSlice, getModelThinkingLevels, normalizeThinkingLevel, type ModelSlice } from '../../stores/model-slice';

function makeSlice(): ModelSlice {
  let state: ModelSlice;
  const set = (partial: Partial<ModelSlice>) => {
    state = { ...state, ...partial };
  };
  state = createModelSlice(set);
  return new Proxy({} as ModelSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('model-slice thinking defaults', () => {
  it('defaults new UI state to medium rather than legacy auto', () => {
    expect(makeSlice().thinkingLevel).toBe('medium');
  });

  it('uses the same reference card as settings when the runtime model has no saved levels', () => {
    expect(getModelThinkingLevels({ id: 'gpt-6-astra', provider: 'anyrouter' })).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ]);
  });

  it('keeps xhigh distinct from max', () => {
    expect(normalizeThinkingLevel('xhigh')).toBe('xhigh');
    expect(normalizeThinkingLevel('max')).toBe('max');
  });
});
