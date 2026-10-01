type CronCheckSlot = { label: string; count: number };

const checksBySession = new Map<string, Map<string, CronCheckSlot>>();

function wakeKeyOf(wakeKey: string | null | undefined): string {
  return typeof wakeKey === "string" && wakeKey.trim() ? wakeKey.trim() : "*";
}

function slotsFor(sessionPath: string): Map<string, CronCheckSlot> | undefined {
  return checksBySession.get(sessionPath);
}

export function beginSessionCronCheck(sessionPath: string, label: string, wakeKey?: string | null): void {
  if (!sessionPath) return;
  const key = wakeKeyOf(wakeKey);
  let slots = checksBySession.get(sessionPath);
  if (!slots) {
    slots = new Map();
    checksBySession.set(sessionPath, slots);
  }
  const prev = slots.get(key);
  slots.set(key, {
    label: label || prev?.label || "",
    // Explicit wake IDs are idempotent under replay; legacy anonymous events still count.
    count: key === '*' ? (prev?.count || 0) + 1 : 1,
  });
}

export function endSessionCronCheck(sessionPath: string, wakeKey?: string | null): void {
  if (!sessionPath) return;
  const slots = slotsFor(sessionPath);
  if (!slots) return;
  const key = wakeKeyOf(wakeKey);
  const prev = slots.get(key);
  if (!prev) return;
  const next = prev.count - 1;
  if (next <= 0) slots.delete(key);
  else slots.set(key, { ...prev, count: next });
  if (slots.size === 0) checksBySession.delete(sessionPath);
}

export function resetSessionCronCheck(sessionPath: string): void {
  if (!sessionPath) return;
  checksBySession.delete(sessionPath);
}

export function isSessionCronCheck(sessionPath: string | null | undefined): boolean {
  if (!sessionPath) return false;
  const slots = slotsFor(sessionPath);
  return !!slots && slots.size > 0;
}

/**
 * End one wake. The session stays in checking until every overlapping wake
 * has ended. preserveClientState is the busy follow-up path: the marker
 * must release without forcing streaming off or reloading history.
 */
export function settleSessionCronRotation(
  sessionPath: string,
  wakeKey?: string | null,
  options: { preserveClientState?: boolean } = {},
): { stillChecking: boolean; preserveClientState: boolean; shouldSettle: boolean } {
  const hadWake = slotsFor(sessionPath)?.has(wakeKeyOf(wakeKey)) === true;
  endSessionCronCheck(sessionPath, wakeKey);
  const stillChecking = isSessionCronCheck(sessionPath);
  const preserveClientState = options.preserveClientState === true;
  return {
    stillChecking,
    preserveClientState,
    shouldSettle: hadWake && !preserveClientState && !stillChecking,
  };
}
