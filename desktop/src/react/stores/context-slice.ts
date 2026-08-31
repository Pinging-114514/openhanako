import { sessionScopedKey, sessionScopedListIncludes, sessionScopedValue, type SessionLocatorState } from './session-slice';

export interface SessionLoopStatus {
  status: string;
  prompt: string;
  turnCount: number;
  maxTurns: number;
  pausedReason?: string | null;
  alarmWakeAt?: number | null;
  alarmReason?: string | null;
  completedSummary?: string | null;
}

export interface ContextSlice {
  /** Context usage — token count for the current session */
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  /** 按 session identity key 存储的 context usage（读旧 path key 兼容） */
  contextBySession: Record<string, { tokens: number | null; window: number | null; percent: number | null }>;
  /** Session identity keys currently undergoing compaction */
  compactingSessions: string[];
  /** Compaction mode for each busy session, keyed by session identity. */
  compactionModeBySession: Record<string, string>;
  /** Active /loop status keyed by session identity. */
  loopBySession: Record<string, SessionLoopStatus>;
  setSessionLoop: (path: string, loop: SessionLoopStatus | null) => void;
  addCompactingSession: (path: string, mode?: string | null) => void;
  removeCompactingSession: (path: string) => void;
}

export const createContextSlice = (
  set: (partial: Partial<ContextSlice> | ((s: ContextSlice) => Partial<ContextSlice>)) => void
): ContextSlice => ({
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  contextBySession: {},
  compactingSessions: [],
  compactionModeBySession: {},
  loopBySession: {},
  setSessionLoop: (path, loop) => set((s) => {
    const key = sessionScopedKey(s as ContextSlice & SessionLocatorState, path) || path;
    const loopBySession = { ...s.loopBySession };
    delete loopBySession[key];
    delete loopBySession[path];
    if (loop && (loop.status === 'running' || loop.status === 'paused')) {
      loopBySession[key] = loop;
    }
    return { loopBySession };
  }),
  addCompactingSession: (path, mode) => set((s) => {
    const key = sessionScopedKey(s as ContextSlice & SessionLocatorState, path) || path;
    const compactingSessions = s.compactingSessions.filter((item) => item !== key && item !== path);
    const compactionModeBySession = { ...s.compactionModeBySession };
    const normalizedMode = typeof mode === 'string' && mode.trim() ? mode.trim() : null;
    const existingMode = compactionModeBySession[key] || compactionModeBySession[path];
    delete compactionModeBySession[key];
    delete compactionModeBySession[path];
    if (normalizedMode || existingMode) {
      compactionModeBySession[key] = normalizedMode || existingMode;
    }
    return { compactingSessions: [...compactingSessions, key], compactionModeBySession };
  }),
  removeCompactingSession: (path) => set((s) => {
    const key = sessionScopedKey(s as ContextSlice & SessionLocatorState, path) || path;
    const compactionModeBySession = { ...s.compactionModeBySession };
    delete compactionModeBySession[key];
    delete compactionModeBySession[path];
    return {
      compactingSessions: s.compactingSessions.filter(p => p !== key && p !== path),
      compactionModeBySession,
    };
  }),
});

// ── Selectors ──
export const selectContextTokens = (s: ContextSlice) => s.contextTokens;
export const selectContextWindow = (s: ContextSlice) => s.contextWindow;
export const selectContextPercent = (s: ContextSlice) => s.contextPercent;

export function isSessionCompacting(
  state: ContextSlice & SessionLocatorState,
  sessionPath: string | null | undefined,
): boolean {
  return sessionScopedListIncludes(state, state.compactingSessions, sessionPath);
}

export function getSessionLoop(
  state: ContextSlice & SessionLocatorState,
  sessionPath: string | null | undefined,
): SessionLoopStatus | null {
  if (!sessionPath) return null;
  return sessionScopedValue(state, state.loopBySession, sessionPath) || null;
}

export function mergeSessionContextUsage(
  existing: { tokens: number | null; window: number | null; percent: number | null } | null | undefined,
  incoming: { tokens?: number | null; contextWindow?: number | null; percent?: number | null },
): { tokens: number | null; window: number | null; percent: number | null } {
  const tokens = Number.isFinite(incoming.tokens) ? Number(incoming.tokens) : (existing?.tokens ?? null);
  const window = Number.isFinite(incoming.contextWindow) ? Number(incoming.contextWindow) : (existing?.window ?? null);
  let percent = Number.isFinite(incoming.percent) ? Number(incoming.percent) : (existing?.percent ?? null);
  if (!Number.isFinite(incoming.percent) && Number.isFinite(tokens) && Number.isFinite(window) && (window as number) > 0) {
    percent = (Number(tokens) / Number(window)) * 100;
  }
  return { tokens, window, percent };
}

export function getSessionCompactionMode(
  state: ContextSlice & SessionLocatorState,
  sessionPath: string | null | undefined,
): string | null {
  if (!sessionPath || !isSessionCompacting(state, sessionPath)) return null;
  const key = sessionScopedKey(state, sessionPath);
  if (key && Object.prototype.hasOwnProperty.call(state.compactionModeBySession, key)) {
    return state.compactionModeBySession[key] || null;
  }
  return state.compactionModeBySession[sessionPath] || null;
}
