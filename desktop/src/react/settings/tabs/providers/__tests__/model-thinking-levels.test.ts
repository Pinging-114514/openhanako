import { describe, expect, it } from 'vitest';
import {
  resolveEditorThinkingState,
  snapDefaultThinkingLevel,
  toggleEditorThinkingLevel,
} from '../model-thinking-levels';

describe('resolveEditorThinkingState', () => {
  it('falls back to off/medium/high when nothing is declared', () => {
    expect(resolveEditorThinkingState({ reasoning: true }, {})).toEqual({
      levels: ['off', 'medium', 'high'],
      defaultLevel: 'medium',
    });
  });

  it('adds xhigh when the model is marked xhigh and has no explicit list', () => {
    expect(resolveEditorThinkingState({ xhigh: true }, {})).toEqual({
      levels: ['off', 'medium', 'high', 'xhigh'],
      defaultLevel: 'medium',
    });
  });

  it('prefers the user list over the built-in list', () => {
    expect(resolveEditorThinkingState(
      { thinkingLevels: ['low', 'high'], defaultThinkingLevel: 'high' },
      { thinkingLevels: ['off', 'low', 'medium', 'high', 'max'], defaultThinkingLevel: 'medium' },
    )).toEqual({
      levels: ['low', 'high'],
      defaultLevel: 'high',
    });
  });

  it('uses the built-in list when the user has not customized it', () => {
    expect(resolveEditorThinkingState(
      { id: 'gpt-5.6-sol', reasoning: true },
      { thinkingLevels: ['low', 'medium', 'high', 'max'], defaultThinkingLevel: 'low' },
    )).toEqual({
      levels: ['low', 'medium', 'high', 'max'],
      defaultLevel: 'low',
    });
  });
});

describe('toggleEditorThinkingLevel', () => {
  it('keeps canonical order when adding a level', () => {
    expect(toggleEditorThinkingLevel(['off', 'medium', 'high'], 'low')).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
  });

  it('does not clear the last remaining level', () => {
    expect(toggleEditorThinkingLevel(['high'], 'high')).toEqual(['high']);
  });
});

describe('snapDefaultThinkingLevel', () => {
  it('keeps the current default when it is still selected', () => {
    expect(snapDefaultThinkingLevel(['off', 'high'], 'high')).toBe('high');
  });

  it('falls back to medium, then the first selected level', () => {
    expect(snapDefaultThinkingLevel(['off', 'medium', 'high'], 'low')).toBe('medium');
    expect(snapDefaultThinkingLevel(['off', 'high'], 'medium')).toBe('off');
  });
});
