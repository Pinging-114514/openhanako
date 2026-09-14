/**
 * PiAuthStore — Hana 侧的凭证门面（pi-coding-agent 0.80.8+ 契约）。
 *
 * 0.80.8 之前 AuthStorage 一个对象管三件事：auth.json 读写、OAuth provider
 * 注册表、登录/刷新/取 key。0.80.8 起拆成两层：
 *   - AuthStorage：只是 auth.json 的 CredentialStore（read / modify / delete / list）
 *   - ModelRuntime：provider 注册、登录、刷新、getAuth，刷新在 store 的锁里跑
 *
 * Hana 的路由、model-manager、engine 之前只认旧 AuthStorage 的方法名。这里把
 * 两层重新装回一个对象，方法名对齐旧调用方，语义按新契约实现：
 *   - 读是同步的（直接读文件，auth.json 就是真相），写和取 key 是 async
 *   - 强制旋转走 credentials.modify：同一把跨进程文件锁，别的执行流刚换过就复用
 *
 * 纪律：只有 lib/pi-sdk 允许 import "@earendil-works/*"，本文件属于适配层。
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Credential, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import {
  loginOAuthProvider,
  readStoredCredential,
  type OAuthLoginCallbacks,
  type SdkCredentialStore,
} from "./index.ts";

export interface OAuthProviderSummary {
  id: string;
  name: string;
  /** pi 原生 OAuth（openai-codex 等）走本地回调服务器并接受手动粘贴授权码。 */
  usesCallbackServer: boolean;
}

export interface RotateOAuthOptions {
  /** 调用方手上那个被拒收的 token；存储里已经不是它就直接复用新 token。 */
  staleApiKey?: string;
  signal?: AbortSignal;
}

function isOAuthCredential(value: Credential | undefined): value is OAuthCredential {
  return !!value
    && value.type === "oauth"
    && typeof (value as OAuthCredential).access === "string"
    && typeof (value as OAuthCredential).refresh === "string";
}

export class PiAuthStore {
  readonly credentials: SdkCredentialStore;
  readonly authPath: string;
  private _runtime: ModelRuntime | null;

  constructor(options: { credentials: SdkCredentialStore; authPath: string; runtime?: ModelRuntime | null }) {
    this.credentials = options.credentials;
    this.authPath = options.authPath;
    this._runtime = options.runtime ?? null;
  }

  get runtime(): ModelRuntime {
    if (!this._runtime) {
      throw new Error("PiAuthStore: ModelRuntime is not attached yet");
    }
    return this._runtime;
  }

  get hasRuntime(): boolean {
    return this._runtime !== null;
  }

  attachRuntime(runtime: ModelRuntime) {
    this._runtime = runtime;
  }

  /** Re-read auth.json into the store's in-memory view. */
  reload() {
    this.credentials.reload();
  }

  /**
   * Synchronous, lock-free read of one stored credential (display / status use).
   * Hana keeps extra fields on OAuth entries (accountId, resourceUrl, ...), so
   * the return type is the SDK credential plus an open bag.
   */
  get(providerId: string): (Credential & Record<string, any>) | undefined {
    if (!providerId) return undefined;
    return readStoredCredential(providerId, this.authPath) as (Credential & Record<string, any>) | undefined;
  }

  has(providerId: string): boolean {
    return this.get(providerId) !== undefined;
  }

  async remove(providerId: string): Promise<void> {
    await this.credentials.delete(providerId);
  }

  /** Request-ready API key for a provider; pi refreshes an expiring OAuth token under the store lock. */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const result = await this.runtime.getAuth(providerId);
    return result?.auth?.apiKey;
  }

  /** Providers (native or Hana-registered) that can log in through OAuth. */
  getOAuthProviders(): OAuthProviderSummary[] {
    if (!this._runtime) return [];
    const extensionIds = new Set(this._runtime.getRegisteredProviderIds());
    const out: OAuthProviderSummary[] = [];
    for (const provider of this._runtime.getProviders()) {
      if (!provider?.auth?.oauth) continue;
      out.push({
        id: provider.id,
        name: provider.auth.oauth.name || provider.name || provider.id,
        usesCallbackServer: !extensionIds.has(provider.id),
      });
    }
    return out;
  }

  private oauthFor(providerId: string): OAuthAuth {
    const oauth = this.runtime.getProvider(providerId)?.auth?.oauth;
    if (!oauth) {
      throw new Error(`Cannot rotate OAuth credential for "${providerId}": no OAuth provider registered`);
    }
    return oauth;
  }

  login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
    return loginOAuthProvider(this.runtime, providerId, callbacks);
  }

  async logout(providerId: string): Promise<void> {
    await this.runtime.logout(providerId);
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.runtime.setRuntimeApiKey(providerId, apiKey);
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    await this.runtime.removeRuntimeApiKey(providerId);
  }

  /**
   * 无视本地到期时间，立刻旋转 OAuth 凭证。
   *
   * 服务端可能在本地记录的到期时间之前作废 access token（换设备、撤销会话、
   * 缩短有效期）。常规 getApiKey 只在本地过期时才换，这里表达的是
   * "服务端刚拒收了这个 token，现在就换"。
   *
   * 整个读—改—写放在 credentials.modify 的锁里：锁的是 auth.json 这个路径，
   * 与 pi 自己的刷新路径互斥；后进锁的人看到别人已经换好的新凭证就直接复用，
   * 不会把刚换来的 refresh token 再换一次作废掉。
   *
   * 失败一律上抛：条目不存在、不是 OAuth、服务端拒绝换新，都不写盘、不降级。
   */
  async rotateOAuthCredential(providerId: string, options: RotateOAuthOptions = {}): Promise<string> {
    const oauth = this.oauthFor(providerId);
    const signal = options.signal ?? new AbortController().signal;
    let rotated = false;
    const stored = await this.credentials.modify(providerId, async (current) => {
      if (!isOAuthCredential(current)) {
        throw new Error(`Cannot rotate OAuth credential for "${providerId}": no OAuth credential stored`);
      }
      if (options.staleApiKey && current.access !== options.staleApiKey) {
        return undefined;
      }
      rotated = true;
      const refreshed = await oauth.refresh(current, signal);
      return { ...refreshed, type: "oauth" };
    }, { signal });
    const credential = stored ?? await this.credentials.read(providerId, { signal });
    if (!isOAuthCredential(credential)) {
      throw new Error(`Cannot rotate OAuth credential for "${providerId}": no OAuth credential stored`);
    }
    const auth = await oauth.toAuth(credential);
    if (!auth?.apiKey) {
      throw new Error(`Cannot rotate OAuth credential for "${providerId}": provider returned no API key${rotated ? " after refresh" : ""}`);
    }
    return auth.apiKey;
  }
}
