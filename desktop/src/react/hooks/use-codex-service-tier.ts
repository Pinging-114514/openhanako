import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeCodexServiceTier, type CodexServiceTier } from '../../../../shared/codex-service-tier.ts';
import { peekOauthAccountsSlice, subscribeOauthAccounts } from '../stores/oauth-accounts-store';
import {
  interpretCodexTierPayload,
  resolveVisibleCodexTier,
  visibleCodexSpeedTiers,
  type CodexTierPayload,
} from '../utils/codex-speed';

const TIER_PATH = '/api/preferences/codex-service-tier';

function codexTierPath(modelId: unknown): string {
  if (typeof modelId !== 'string' || !modelId.trim()) return TIER_PATH;
  return `${TIER_PATH}?modelId=${encodeURIComponent(modelId.trim())}`;
}

function codexTierBody(tier: string, modelId: unknown, withModel: boolean): string {
  const body: { tier: string; modelId?: string } = { tier };
  if (withModel && typeof modelId === 'string' && modelId.trim()) body.modelId = modelId.trim();
  return JSON.stringify(body);
}

export type CodexTierFetch = (
  path: string,
  init?: RequestInit & { throwOnHttpError?: boolean },
) => Promise<Response>;

export type CodexTierInvalidation = {
  resetEligibility?: boolean;
  planType?: string | null;
};

type InvalidationListener = (detail: CodexTierInvalidation) => void;

const invalidationListeners = new Set<InvalidationListener>();
const downgradeAttempts = new Set<string>();

export function invalidateCodexServiceTier(detail: CodexTierInvalidation = {}): void {
  for (const listener of invalidationListeners) listener(detail);
}

export function resetCodexServiceTierClientForTests(): void {
  downgradeAttempts.clear();
}

export function readCodexAccountSignature(): string {
  const slice = peekOauthAccountsSlice('openai-codex');
  if (!slice.hydrated && slice.accounts.length === 0) return 'pending';
  const active = slice.accounts.find((account) => account.active) || null;
  if (!active) return 'none';
  const plan = String(active.usage?.planType || '').trim().toLowerCase();
  return `${active.id}:${plan}`;
}

function normalizePlan(planType: string | null | undefined): string {
  return String(planType || '').trim().toLowerCase();
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function useCodexServiceTier(
  fetchImpl: CodexTierFetch,
  options: { modelId?: unknown } = {},
) {
  const modelId = options.modelId;
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const signatureRef = useRef(readCodexAccountSignature());
  const planRef = useRef<string | null>(null);
  const serverTierRef = useRef<CodexServiceTier>('standard');
  const [serverTier, setServerTier] = useState<CodexServiceTier>('standard');
  const [ultrafastEligible, setUltrafastEligible] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downgradeUnconfirmed, setDowngradeUnconfirmed] = useState(false);

  const rememberTier = useCallback((tier: CodexServiceTier) => {
    serverTierRef.current = tier;
    setServerTier(tier);
  }, []);

  const applyPayload = useCallback((parsed: CodexTierPayload) => {
    rememberTier(parsed.tier);
    setUltrafastEligible(parsed.ultrafastEligible);
    setDowngradeUnconfirmed(false);
    setReady(true);
  }, [rememberTier]);

  const reload = useCallback(async (detail: CodexTierInvalidation = {}) => {
    const my = ++generation.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signature = readCodexAccountSignature();
    signatureRef.current = signature;
    if (detail.resetEligibility) {
      setUltrafastEligible(false);
      setDowngradeUnconfirmed(false);
    }
    setSaving(false);
    setLoading(true);
    try {
      const res = await fetchRef.current(codexTierPath(modelIdRef.current), {
        signal: controller.signal,
        throwOnHttpError: false,
      });
      if (my !== generation.current) return;
      const parsed = res.ok ? interpretCodexTierPayload(await readJson(res)) : interpretCodexTierPayload(null);
      if (my !== generation.current) return;
      if (!parsed.valid) {
        setUltrafastEligible(false);
        setReady(false);
        if (serverTierRef.current === 'ultrafast') setDowngradeUnconfirmed(true);
        return;
      }
      if (!parsed.needsLegacyDowngrade) {
        applyPayload(parsed);
        return;
      }
      rememberTier(parsed.tier);
      setUltrafastEligible(false);
      setReady(true);
      setDowngradeUnconfirmed(true);
      const attemptKey = `${signature}::ultrafast`;
      if (downgradeAttempts.has(attemptKey)) return;
      downgradeAttempts.add(attemptKey);
      setSaving(true);
      try {
        const putRes = await fetchRef.current(TIER_PATH, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: codexTierBody('fast', modelIdRef.current, false),
          signal: controller.signal,
          throwOnHttpError: false,
        });
        if (my !== generation.current) return;
        const confirmed = putRes.ok
          ? interpretCodexTierPayload(await readJson(putRes))
          : interpretCodexTierPayload(null);
        if (my !== generation.current) return;
        if (confirmed.valid && confirmed.tier !== 'ultrafast') {
          rememberTier(confirmed.tier);
          setUltrafastEligible(false);
          setDowngradeUnconfirmed(false);
          setReady(true);
        } else {
          setUltrafastEligible(false);
          setDowngradeUnconfirmed(true);
        }
      } catch (err) {
        if (my !== generation.current || controller.signal.aborted) return;
        console.error('[codex-speed] downgrade failed:', err);
        setUltrafastEligible(false);
        setDowngradeUnconfirmed(true);
      } finally {
        if (my === generation.current) setSaving(false);
      }
    } catch (err) {
      if (my !== generation.current || controller.signal.aborted) return;
      console.error('[codex-speed] load failed:', err);
      setUltrafastEligible(false);
      setReady(false);
      setDowngradeUnconfirmed(serverTierRef.current === 'ultrafast');
    } finally {
      if (my === generation.current) setLoading(false);
    }
  }, [applyPayload, rememberTier]);

  useEffect(() => {
    const onInvalidate = (detail: CodexTierInvalidation) => {
      if (detail.planType !== undefined) {
        const nextPlan = normalizePlan(detail.planType);
        const planChanged = planRef.current != null && planRef.current !== nextPlan;
        planRef.current = nextPlan;
        void reload({ resetEligibility: detail.resetEligibility === true || planChanged });
        return;
      }
      void reload(detail);
    };
    invalidationListeners.add(onInvalidate);
    const unsubscribeAccounts = subscribeOauthAccounts(() => {
      const next = readCodexAccountSignature();
      if (next === signatureRef.current) return;
      signatureRef.current = next;
      void reload({ resetEligibility: true });
    });
    const onFocus = () => {
      void reload();
    };
    window.addEventListener('focus', onFocus);
    void reload();
    return () => {
      invalidationListeners.delete(onInvalidate);
      unsubscribeAccounts();
      window.removeEventListener('focus', onFocus);
      generation.current += 1;
      abortRef.current?.abort();
    };
  }, [modelId, reload]);

  const eligibleNow = ready && ultrafastEligible;
  const tier = downgradeUnconfirmed
    ? serverTier
    : resolveVisibleCodexTier(serverTier, ultrafastEligible, modelId);
  const choices = visibleCodexSpeedTiers(eligibleNow, modelId);

  const selectTier = useCallback(async (next: string) => {
    const normalized = normalizeCodexServiceTier(next);
    const allowed = visibleCodexSpeedTiers(ultrafastEligible && ready, modelId);
    if (!allowed.includes(normalized) || saving) return;
    const shown = downgradeUnconfirmed
      ? ''
      : resolveVisibleCodexTier(serverTier, ultrafastEligible, modelId);
    if (normalized === shown) return;
    const my = ++generation.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(false);
    setSaving(true);
    try {
      const res = await fetchRef.current(TIER_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: codexTierBody(normalized, modelId, true),
        signal: controller.signal,
        throwOnHttpError: false,
      });
      if (my !== generation.current) return;
      const parsed = interpretCodexTierPayload(await readJson(res));
      if (my !== generation.current) return;
      if (!res.ok || !parsed.valid || (parsed.tier === 'ultrafast' && !parsed.ultrafastEligible)) {
        if (parsed.valid && parsed.tier !== 'ultrafast') {
          applyPayload(parsed);
        } else {
          setUltrafastEligible(false);
          setDowngradeUnconfirmed(parsed.valid && parsed.tier === 'ultrafast');
          if (parsed.valid) setReady(true);
        }
        return;
      }
      applyPayload(parsed);
    } catch (err) {
      if (my !== generation.current || controller.signal.aborted) return;
      console.error('[codex-speed] save failed:', err);
    } finally {
      if (my === generation.current) setSaving(false);
    }
  }, [applyPayload, downgradeUnconfirmed, modelId, ready, saving, serverTier, ultrafastEligible]);

  return {
    tier,
    selectValue: downgradeUnconfirmed ? '' : tier,
    options: choices,
    ultrafastEligible: eligibleNow,
    ready,
    loading,
    saving,
    downgradeUnconfirmed,
    selectTier,
  };
}
