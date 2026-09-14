/**
 * forceRefreshOAuthApiKey — 无视本地到期时间，立刻旋转 OAuth 凭证
 *
 * 为什么需要它：
 *   凭证存储（auth.json）里每条 OAuth 记录都带一个本地记下来的到期时间，
 *   常规取 token 的路径只在"本地时间已过期"时才去换新 token。但服务端可以
 *   在这个时间之前就把 access token 作废（换设备、撤销会话、服务端缩短有效
 *   期等），此时本地账本还认为 token 有效，常规路径会一直把已经被拒收的旧
 *   token 交出去，调用方只能一路撞 401。
 *
 *   这个原语表达的是另一件事：**服务端刚刚拒收了这个 token，现在就换**。
 *   它不看本地到期时间，只看"你手上那个 token 是不是仍然是存储里那个"。
 *
 * 实现在 lib/pi-sdk/auth-store.ts 的 PiAuthStore.rotateOAuthCredential：
 *   - provider 从传进来的 store 背后的 ModelRuntime 上取，不从任何模块级注册表取
 *     （依赖树里有两份 SDK 拷贝，跨拷贝的注册表互相看不见）。
 *   - 读—改—写整个放在 CredentialStore.modify 的锁里，锁的是 auth.json 路径本身，
 *     与 SDK 自己的刷新路径互斥；别人刚换过就直接复用，不会把新 refresh token 作废。
 *
 * 失败一律上抛：解析不了、条目不存在、不是 OAuth、服务端拒绝换新，都直接报
 * 错，不写盘、不降级、不返回旧 token。
 */

interface ForceRefreshOptions {
  /** Hana 的凭证门面（PiAuthStore 或同形状替身） */
  authStore: {
    rotateOAuthCredential: (providerId: string, options?: { staleApiKey?: string }) => Promise<string>;
  } | null | undefined;
  /** auth.json 里的凭证键，例如 "openai-codex" */
  authKey: string;
  /** 调用方手上那个被拒收的 token；用于判断别人是否已经换过 */
  staleApiKey?: string;
}

export async function forceRefreshOAuthApiKey({
  authStore,
  authKey,
  staleApiKey,
}: ForceRefreshOptions): Promise<string> {
  if (!authStore || typeof authStore.rotateOAuthCredential !== "function") {
    throw new Error(`Cannot rotate OAuth credential for "${authKey}": auth storage unavailable`);
  }
  return authStore.rotateOAuthCredential(authKey, { staleApiKey });
}
