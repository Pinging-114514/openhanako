/**
 * Vision watchdog — outer soft-fail timeout around image prepare / auxiliary vision.
 *
 * LLM calls already carry VISION_ANALYSIS_TIMEOUT_MS inside VisionBridge. This layer
 * is a backstop for hangs outside that path (resize, stuck fetch, missed abort) so one
 * bad image cannot freeze the whole turn. Recoverable failures are logged and returned
 * to the caller for soft-fail handling.
 */
import { createModuleLogger } from "../lib/debug-log.ts";

export const VISION_WATCHDOG_TIMEOUT_MS = 150_000;

const log = createModuleLogger("vision-watchdog");

export function isAbortLikeVisionError(err: any) {
  return err?.name === "AbortError"
    || err?.message === "This operation was aborted"
    || err?.type === "aborted";
}

export function isRecoverableVisionWatchdogError(err: any) {
  if (isAbortLikeVisionError(err)) return false;
  if (err?.code === "LLM_AUTH_FAILED") return false;
  if (err?.code === "LLM_TIMEOUT" || err?.code === "LLM_RATE_LIMITED" || err?.code === "LLM_EMPTY_RESPONSE") {
    return true;
  }
  if (err?.retryable === true) return true;
  if (err?.name === "TimeoutError") return true;
  if (err instanceof TypeError && /fetch|network|terminated/i.test(err.message || "")) return true;
  return false;
}

export function createVisionWatchdogTimeoutError(message: string) {
  const err: any = new Error(message);
  err.code = "LLM_TIMEOUT";
  err.retryable = true;
  return err;
}

export function logVisionWatchdog(message: string) {
  try {
    log.warn(message);
  } catch {
    try {
      console.error(`[vision-watchdog] ${message}`);
    } catch {
      // logging must never break the turn
    }
  }
}

/**
 * Race work against a watchdog timer. Clears the timer when either side settles.
 */
export function raceWithVisionWatchdog<T>(
  work: Promise<T>,
  label: string,
  timeoutMs = VISION_WATCHDOG_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(createVisionWatchdogTimeoutError(label));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
