export const EDITABLE_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EditableThinkingLevel = typeof EDITABLE_THINKING_LEVELS[number];

const DEFAULT_VISIBLE_THINKING_LEVELS: EditableThinkingLevel[] = ['off', 'medium', 'high'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeEditorThinkingLevel(level: unknown): EditableThinkingLevel | null {
  if (typeof level !== 'string') return null;
  const normalized = level.trim().toLowerCase();
  if (normalized === 'auto') return 'medium';
  return (EDITABLE_THINKING_LEVELS as readonly string[]).includes(normalized)
    ? normalized as EditableThinkingLevel
    : null;
}

export function normalizeEditorThinkingLevels(levels: unknown): EditableThinkingLevel[] | null {
  if (!Array.isArray(levels)) return null;
  const out: EditableThinkingLevel[] = [];
  for (const raw of levels) {
    const level = normalizeEditorThinkingLevel(raw);
    if (!level || out.includes(level)) continue;
    out.push(level);
  }
  return out.length > 0 ? out : null;
}

export function resolveEditorThinkingState(
  userMeta: Record<string, unknown> | null | undefined,
  knownMeta: Record<string, unknown> | null | undefined,
): { levels: EditableThinkingLevel[]; defaultLevel: EditableThinkingLevel } {
  const merged = { ...(knownMeta || {}), ...(userMeta || {}) };
  const explicit = normalizeEditorThinkingLevels(merged.thinkingLevels);
  const thinkingLevelMap = isRecord(merged.thinkingLevelMap) ? merged.thinkingLevelMap : null;
  const levels = explicit ?? [...DEFAULT_VISIBLE_THINKING_LEVELS];
  if (!explicit) {
    if (merged.xhigh === true || typeof thinkingLevelMap?.xhigh === 'string') {
      if (!levels.includes('xhigh')) levels.push('xhigh');
    }
    if (typeof thinkingLevelMap?.max === 'string' && !levels.includes('max')) levels.push('max');
  }
  const requested = normalizeEditorThinkingLevel(merged.defaultThinkingLevel);
  const defaultLevel = requested && levels.includes(requested)
    ? requested
    : (levels.includes('medium') ? 'medium' : levels[0]);
  return { levels, defaultLevel };
}

export function toggleEditorThinkingLevel(
  selected: readonly EditableThinkingLevel[],
  level: EditableThinkingLevel,
): EditableThinkingLevel[] {
  if (selected.includes(level)) {
    if (selected.length <= 1) return [...selected];
    return selected.filter((item) => item !== level);
  }
  return EDITABLE_THINKING_LEVELS.filter((item) => item === level || selected.includes(item));
}

export function snapDefaultThinkingLevel(
  selected: readonly EditableThinkingLevel[],
  current: EditableThinkingLevel,
): EditableThinkingLevel {
  if (selected.includes(current)) return current;
  if (selected.includes('medium')) return 'medium';
  return selected[0] || 'medium';
}
