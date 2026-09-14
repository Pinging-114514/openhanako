import fs from "node:fs";
import { AuthStorage, type SdkCredentialStore } from "../pi-sdk/index.ts";

export type AuthStorageBootLog = (line: string) => void;

function sleepSync(ms: number) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * auth.json 能不能被解析成对象。文件不存在算可读（空存储），只有存在但
 * 读不出 / 不是合法 JSON 对象才算失败。
 */
function readAuthFileError(authPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return error instanceof Error ? error.message : String(error);
  }
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "auth.json is not a JSON object";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 开机读 auth.json 的短暂失败不能让登录态变成空存储。
 * 典型的是上一次进程还没写完就退出、或另一个进程正持锁写文件：此时读到的是半截
 * 内容，直接开店会让设置页显示未登录，logout 时还会把空内容写回去，凭证就丢了。
 *
 * 0.80.8 起 AuthStorage 不再暴露 drainErrors，所以在创建存储之前先自己读一遍文件
 * 确认可解析，短暂失败就重试几次再创建。
 */
export function createAuthStorageWithRetry(
  authPath: string,
  options: { log?: AuthStorageBootLog; retries?: number; delayMs?: number } = {},
): SdkCredentialStore {
  const log = options.log || (() => {});
  const retries = Number.isInteger(options.retries) && (options.retries as number) > 0
    ? options.retries as number
    : 5;
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, Number(options.delayMs)) : 50;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const detail = readAuthFileError(authPath);
    if (detail === null) {
      if (attempt > 0) log(`[auth-storage] auth.json loaded after ${attempt} retry(ies)`);
      break;
    }
    if (attempt === retries) {
      log(`[auth-storage] auth.json still unreadable after ${retries} retry(ies): ${detail}`);
      break;
    }
    log(`[auth-storage] auth.json load failed (${detail}); retry ${attempt + 1}/${retries}`);
    sleepSync(delayMs);
  }
  return AuthStorage.create(authPath);
}
