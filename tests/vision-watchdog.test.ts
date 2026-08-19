import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VISION_WATCHDOG_TIMEOUT_MS,
  createVisionWatchdogTimeoutError,
  isRecoverableVisionWatchdogError,
  raceWithVisionWatchdog,
} from "../core/vision-watchdog.ts";

describe("vision-watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks watchdog timeouts as recoverable LLM_TIMEOUT errors", () => {
    const err = createVisionWatchdogTimeoutError("image prepare watchdog timeout");
    expect(err.code).toBe("LLM_TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(isRecoverableVisionWatchdogError(err)).toBe(true);
  });

  it("does not treat abort or auth failures as recoverable", () => {
    const abort: any = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isRecoverableVisionWatchdogError(abort)).toBe(false);

    const auth: any = new Error("auth failed");
    auth.code = "LLM_AUTH_FAILED";
    expect(isRecoverableVisionWatchdogError(auth)).toBe(false);
  });

  it("rejects with a watchdog timeout when work hangs", async () => {
    vi.useFakeTimers();
    const pending = raceWithVisionWatchdog(new Promise(() => {}), "image prepare watchdog timeout", 1_000);
    const assertion = expect(pending).rejects.toMatchObject({
      message: "image prepare watchdog timeout",
      code: "LLM_TIMEOUT",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("resolves the work result and clears the timer on success", async () => {
    vi.useFakeTimers();
    const pending = raceWithVisionWatchdog(Promise.resolve("ok"), "image prepare watchdog timeout");
    await expect(pending).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(VISION_WATCHDOG_TIMEOUT_MS + 1_000);
  });
});
