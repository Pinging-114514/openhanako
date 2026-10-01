import type { Model } from '../types';
import { lookupReferenceModelMeta } from '../utils/model-metadata';

export type ThinkingLevel = 'off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ['off', 'medium', 'high'];

export function normalizeThinkingLevel(level: ThinkingLevel): ThinkingLevel {
  if (level === 'auto') return 'medium';
  return level;
}

export function normalizeThinkingLevels(levels: readonly ThinkingLevel[] | null | undefined): ThinkingLevel[] | null {
  if (!Array.isArray(levels)) return null;
  const normalized: ThinkingLevel[] = [];
  for (const rawLevel of levels) {
    const level = normalizeThinkingLevel(rawLevel);
    if (!normalized.includes(level)) normalized.push(level);
  }
  return normalized.length > 0 ? normalized : null;
}

export function getModelThinkingLevels(model: {
  thinkingLevels?: readonly ThinkingLevel[];
  xhigh?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
} | null | undefined): ThinkingLevel[] {
  const explicit = normalizeThinkingLevels(model?.thinkingLevels);
  if (explicit) return explicit;
  if (model && "id" in model && typeof (model as { id?: string }).id === "string") {
    const card = lookupReferenceModelMeta(
      (model as { id: string }).id,
      (model as { provider?: string }).provider,
    );
    const displayed = normalizeThinkingLevels(card?.thinkingLevels as ThinkingLevel[] | undefined);
    if (displayed) return displayed;
  }
  const levels: ThinkingLevel[] = [...DEFAULT_THINKING_LEVELS];
  if (model?.xhigh === true || typeof model?.thinkingLevelMap?.xhigh === 'string') {
    levels.push('xhigh');
  }
  if (typeof model?.thinkingLevelMap?.max === 'string' && !levels.includes('max')) {
    levels.push('max');
  }
  return levels;
}

export interface ModelSlice {
  models: Model[];
  currentModel: { id: string; provider: string } | null;
  thinkingLevel: ThinkingLevel;
  setModels: (models: Model[]) => void;
  setCurrentModel: (model: { id: string; provider: string } | null) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

export const createModelSlice = (
  set: (partial: Partial<ModelSlice>) => void
): ModelSlice => ({
  models: [],
  currentModel: null,
  thinkingLevel: 'medium',
  setModels: (models) => set({ models }),
  setCurrentModel: (model) => set({ currentModel: model }),
  setThinkingLevel: (level) => set({ thinkingLevel: normalizeThinkingLevel(level) }),
});
