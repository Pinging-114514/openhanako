import {
  currentEnvProxyFingerprint,
  detectOsSystemProxy,
  fingerprintSystemProxy,
  stampDetectedProxyEnv,
} from "./system-proxy-detect.ts";

export function startSystemProxySync(options: {
  getMode: () => string;
  apply: (config: { mode: string }) => void;
  log?: (line: string) => void;
  intervalMs?: number;
  env?: Record<string, string | undefined>;
  detect?: typeof detectOsSystemProxy;
}): { stop: () => void; sync: () => Promise<boolean> } {
  const log = options.log || (() => {});
  const env = options.env || process.env;
  const detect = options.detect || detectOsSystemProxy;
  const intervalMs = Math.max(3000, Number(options.intervalMs) || 10_000);
  let stopped = false;
  let inFlight = false;

  const sync = async () => {
    if (stopped || options.getMode() !== "system") return false;
    const detected = await detect();
    const next = fingerprintSystemProxy(detected);
    const current = currentEnvProxyFingerprint(env);
    if (next === current) return false;
    stampDetectedProxyEnv(detected, env);
    options.apply({ mode: "system" });
    const shown = detected.httpsProxy || detected.httpProxy || detected.socksProxy || "(direct)";
    log(`[proxy] system proxy refreshed: ${shown}`);
    return true;
  };

  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void sync().finally(() => {
      inFlight = false;
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    sync,
  };
}
