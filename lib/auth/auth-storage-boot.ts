import { AuthStorage } from "../pi-sdk/index.ts";

export type AuthStorageBootLog = (line: string) => void;

function sleepSync(ms: number) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadErrors(storage: { drainErrors?: () => unknown[] }) {
  const drained = storage.drainErrors?.();
  return Array.isArray(drained) ? drained : [];
}

/**
 * AuthStorage.create() 读盘失败时会吞掉错误、内存留空。
 * 开机第一次常见：上次没卸干净的 auth.json 锁、或时钟还没对上导致锁看起来没过期。
 * 设置页就会显示未登录；logout 在 loadError 时也不写盘，所以退出是空操作。
 */
export function createAuthStorageWithRetry(
  authPath: string,
  options: { log?: AuthStorageBootLog; retries?: number; delayMs?: number } = {},
) {
  const log = options.log || (() => {});
  const retries = Number.isInteger(options.retries) && (options.retries as number) > 0
    ? options.retries as number
    : 5;
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, Number(options.delayMs)) : 50;

  const storage = AuthStorage.create(authPath);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const errors = loadErrors(storage);
    if (errors.length === 0) {
      if (attempt > 0) log(`[auth-storage] auth.json loaded after ${attempt} reload(s)`);
      return storage;
    }
    const detail = errors[0] instanceof Error ? errors[0].message : String(errors[0] || "unknown error");
    if (attempt === retries) {
      log(`[auth-storage] auth.json still unreadable after ${retries} reload(s): ${detail}`);
      return storage;
    }
    log(`[auth-storage] auth.json load failed (${detail}); retry ${attempt + 1}/${retries}`);
    sleepSync(delayMs);
    storage.reload();
  }
  return storage;
}
