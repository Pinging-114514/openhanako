import { MULTI_OAUTH_AUTH_KEYS } from "./oauth-account-identity.ts";
import { refreshOauthAccountUsages } from "./oauth-account-vault.ts";

export const OAUTH_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const OAUTH_USAGE_REFRESH_START_DELAY_MS = 20 * 1000;

export function startOauthUsageRefreshLoop(
  engine: any,
  opts: { intervalMs?: number; startDelayMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? OAUTH_USAGE_REFRESH_INTERVAL_MS;
  const startDelayMs = opts.startDelayMs ?? OAUTH_USAGE_REFRESH_START_DELAY_MS;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    for (const authKey of MULTI_OAUTH_AUTH_KEYS) {
      if (stopped) return;
      try {
        await refreshOauthAccountUsages(engine, authKey);
      } catch {
        // One dead provider must not stall the other.
      }
    }
  };

  const first = setTimeout(() => {
    void tick();
  }, startDelayMs);
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  first.unref?.();
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
