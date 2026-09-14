/**
 * PI SDK Adapter — 所有 PI SDK 导入的唯一入口
 *
 * 稳定 API 直接 re-export，不稳定 API 通过适配函数封装。
 * 消费方不应直接 import "@earendil-works/..."，全部从这里导入。
 *
 * 纪律：
 *   - 不接受 engine / agent / config 参数
 *   - 不拼 session options（compaction、thinkingLevel 等）
 *   - 不做工具过滤 / plan mode 逻辑
 *   - 不持有任何状态
 */

import {
  createAgentSession as rawCreateAgentSession,
  ModelRegistry,
  ModelRuntime,
  readStoredCredential as rawReadStoredCredential,
  resizeImage as rawResizeImage,
  formatDimensionNote as rawFormatDimensionNote,
  convertToLlm as rawConvertToLlm,
} from "@earendil-works/pi-coding-agent";
// 0.80.8 起 AuthStorage / FileAuthStorageBackend 不再从包根导出（凭证编排改由
// ModelRuntime 负责），auth.json 存储实现仍在包内。深路径保留（升级时必查此文件是否存在）
import {
  AuthStorage as RawAuthStorage,
  FileAuthStorageBackend as RawFileAuthStorageBackend,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
// 0.80.0 起 pi-ai 老全局 API 移到 /compat 子入口（根入口是 createModels 新 API）
import {
  getModel as rawGetPiModel,
  getModels as rawGetPiModels,
  completeSimple as rawCompleteSimple,
} from "@earendil-works/pi-ai/compat";
import {
  normalizeCreateAgentSessionOptions,
  PI_BUILTIN_TOOL_NAMES,
} from "./session-options.ts";
import { installAssistantStreamGuard } from "./stream-guard.ts";
import { installToolOutcomeAdapter } from "./tool-outcome-adapter.ts";
import { installRetryPolicy } from "./retry-policy.ts";
import {
  createFindTool,
  createGrepTool,
} from "./search-tools.ts";
// prepareCompaction 0.85.1 仍未从包根导出，深路径保留（升级时必查此文件是否存在）
import {
  prepareCompaction as rawPrepareCompaction,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

// ── Session 管理 ──
export { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// ── 低层 AgentLoop（隔离 side lane 用）──
export { runAgentLoop } from "@earendil-works/pi-agent-core";
export type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";

/**
 * Hana 侧保持稳定的 Tool[] 调用契约，适配层负责转换 Pi SDK 版本差异。
 *
 * Pi SDK 0.68+ 将 `tools` 改成 string[] allowlist；Hana 的沙盒工具仍然
 * 是 session 级对象，必须先注册为同名 customTools，再用名字启用。
 *
 * @param {object} options
 */
export async function createAgentSession(options) {
  const resourceLoaderAgentDir = options?.resourceLoader?.agentDir;
  const withAgentDir = !options?.agentDir && typeof resourceLoaderAgentDir === "string" && resourceLoaderAgentDir
    ? { ...options, agentDir: resourceLoaderAgentDir }
    : options;
  // 0.80.8 起 createAgentSession 只认 `modelRuntime`。Hana 调用方仍传
  // `authStorage` + `modelRegistry`（ModelManager 的两个句柄），这里翻译成
  // registry 背后那个 runtime，并把 SDK 不再认识的两个键拿掉。
  const sessionOptions = translateSessionRuntimeOptions(withAgentDir);
  const result = await rawCreateAgentSession(normalizeCreateAgentSessionOptions(sessionOptions));
  installToolOutcomeAdapter(result?.session);
  installAssistantStreamGuard(result?.session);
  installRetryPolicy(result?.session);
  return result;
}

// ── 内置工具名常量 ──
export { PI_BUILTIN_TOOL_NAMES };

// ── 工具工厂（沙盒用）──
export {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
export { createGrepTool, createFindTool };

// ── 资源加载 ──
export { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

// ── Utilities ──
export { formatSkillsForPrompt, getLastAssistantUsage } from "@earendil-works/pi-coding-agent";

// ── 凭证存储 / 模型运行时（0.80.8+ 契约）──
//
// auth.json 仍由 pi 的 AuthStorage 持有（它现在只是一个 CredentialStore：
// read / modify / delete / list），登录、刷新、取 key 全部经 ModelRuntime。
// Hana 侧的 OAuth 门面在 ./auth-store.ts，消费方不要直接碰这两个类。
export const AuthStorage = RawAuthStorage;
export const FileAuthStorageBackend = RawFileAuthStorageBackend;
export type SdkCredentialStore = RawAuthStorage;
export type SdkModelRuntime = ModelRuntime;
export type SdkModelRegistry = ModelRegistry;

export type SdkProviderRegistrationConfig = Parameters<ModelRegistry["registerProvider"]>[1];
export type SdkOAuthProvider = NonNullable<SdkProviderRegistrationConfig["oauth"]>;
/**
 * The legacy extension login callback contract (`onAuth` / `onDeviceCode` /
 * `onPrompt` / `onSelect` / `onManualCodeInput` / `signal`). Derived from the
 * SDK's extension OAuth type so an upgrade fails Hana's typecheck here.
 */
export type OAuthLoginCallbacks = Parameters<SdkOAuthProvider["login"]>[0];
export type SdkAuthInteraction = Parameters<ModelRuntime["login"]>[2];

/** One-off synchronous read of auth.json, no store, no key resolution. */
export function readStoredCredential(providerId: string, authPath: string) {
  return rawReadStoredCredential(providerId, authPath);
}

export interface CreateModelRuntimeOptions {
  credentials: RawAuthStorage;
  authPath: string;
  modelsJsonPath: string;
}

/**
 * ModelRuntime 工厂（0.80.8 起取代 ModelRegistry.create(authStorage, modelsJsonPath)）。
 * 不联网刷新目录：Hana 自己拥有 models.json，远程目录同步是 Hana 的事。
 */
export function createModelRuntime(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: options.credentials,
    authPath: options.authPath,
    modelsPath: options.modelsJsonPath,
    allowModelNetwork: false,
  });
}

const runtimeByRegistry = new WeakMap<object, ModelRuntime>();

/**
 * Translate Hana's `{ authStorage, modelRegistry }` session handles into the
 * SDK's `modelRuntime` option. Unknown legacy keys are dropped so they never
 * reach createAgentSession.
 */
export function translateSessionRuntimeOptions(options) {
  if (!options || typeof options !== "object") return options;
  const { authStorage: _authStorage, modelRegistry, modelRuntime, ...rest } = options;
  const runtime = modelRuntime
    ?? (modelRegistry ? runtimeByRegistry.get(modelRegistry) : undefined)
    ?? (_authStorage && typeof _authStorage === "object" && "runtime" in _authStorage
      ? (_authStorage as { runtime?: ModelRuntime }).runtime
      : undefined);
  return runtime ? { ...rest, modelRuntime: runtime } : rest;
}

/**
 * OAuth login adapter: Hana keeps the legacy callback contract at its route
 * boundary and translates it into the SDK's AuthInteraction here.
 */
export function loginOAuthProvider(
  runtime: ModelRuntime,
  providerId: string,
  callbacks: OAuthLoginCallbacks,
): Promise<void> {
  return runtime.login(providerId, "oauth", toAuthInteraction(callbacks)).then(() => undefined);
}

export function toAuthInteraction(callbacks: OAuthLoginCallbacks): SdkAuthInteraction {
  const cb = callbacks as OAuthLoginCallbacks & {
    onManualCodeInput?: () => Promise<string>;
    onSelect?: (prompt: any) => Promise<string>;
    onProgress?: (message: string) => void;
  };
  return {
    signal: cb.signal,
    notify(event) {
      switch (event.type) {
        case "auth_url":
          cb.onAuth?.({ url: event.url, instructions: event.instructions });
          return;
        case "device_code":
          if (typeof cb.onDeviceCode === "function") {
            cb.onDeviceCode({
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              intervalSeconds: event.intervalSeconds,
              expiresInSeconds: event.expiresInSeconds,
            });
          } else {
            cb.onAuth?.({ url: event.verificationUri, instructions: event.userCode });
          }
          return;
        case "progress":
        case "info":
          cb.onProgress?.(event.message);
          return;
        default:
          return;
      }
    },
    async prompt(prompt) {
      switch (prompt.type) {
        case "manual_code":
          if (typeof cb.onManualCodeInput === "function") return cb.onManualCodeInput();
          return cb.onPrompt(prompt as any);
        case "select":
          if (typeof cb.onSelect === "function") return cb.onSelect(prompt);
          throw new Error(`OAuth login for this provider needs a selection (${prompt.message}) that Hana does not support`);
        default:
          return cb.onPrompt(prompt as any);
      }
    },
  };
}

// ── Session/history utilities ──
export {
  calculateContextTokens,
  estimateTokens, findCutPoint,
  serializeConversation, shouldCompact,
  parseSessionEntries, buildSessionContext,
} from "@earendil-works/pi-coding-agent";

// Diary material summarization only. Context compaction must go through core/session-compactor.ts.
export { generateSummary } from "@earendil-works/pi-coding-agent";
export {
  buildNativeCompactionRequestShapes,
  NATIVE_SUMMARIZATION_SYSTEM_PROMPT,
} from "./compaction-request-shape.ts";

export const completeSimple = rawCompleteSimple;
export const convertAgentMessagesToLlm = rawConvertToLlm;
export const prepareCompaction = rawPrepareCompaction;

// ── pi-ai（直接依赖，版本与 pi-coding-agent 锁死同版本。注意：上游发布物
// 携带 overrides 致 npm 子树隔离，pi-coding-agent 下必然嵌套第二份 pi-ai，
// 根级同版本挡不住这份拷贝；typebox schema 为字符串键、事件流为鸭子类型，
// 跨实例安全，但任何"模块级单例注册表"类 API（如 pi-ai/oauth 的 provider
// registry）都会双实例互不可见，禁止经由本门面暴露）──
export { StringEnum } from "@earendil-works/pi-ai";

export function getPiModel(provider, modelId) {
  return rawGetPiModel(provider, modelId);
}

export function getPiModels(provider) {
  return rawGetPiModels(provider);
}

// ── Schema 构造（typebox 的 Type 透过 adapter，避免工具直接依赖第三方包名）──
export { Type } from "typebox";

// ── 类型 re-export（供 JSDoc 引用）──
/** @typedef {import('@earendil-works/pi-coding-agent').ToolDefinition} ToolDefinition */

// ── Lifecycle helpers ──

/**
 * Emit `session_shutdown` event to the session's extension runner.
 *
 * 为什么在 adapter 层实现而不从 SDK 导出:
 *   SDK 的 emitSessionShutdownEvent 辅助函数只在 core/extensions/runner.js
 *   内部暴露, 顶级 index.js 未 re-export。直接 import 深层路径会违反
 *   adapter 纪律。实现本身仅 7 行, 自己实现更干净。
 *
 * 契约: AgentSession.dispose() 本身不 emit shutdown, 调用方必须在
 *   dispose 前显式 emit, 否则监听 session_shutdown 的扩展(如
 *   deferred-result-ext) 无法清理自身的 setInterval 和 store 订阅,
 *   导致长期运行进程的内存泄漏。
 *
 * @param {object} session - AgentSession 实例
 * @returns {Promise<boolean>} 事件是否被 emit (false = 无 handler)
 */
export async function emitSessionShutdown(session) {
  const runner = session?.extensionRunner;
  if (runner?.hasHandlers?.("session_shutdown")) {
    await runner.emit({ type: "session_shutdown" });
    return true;
  }
  return false;
}

// ── 不稳定 API 适配 ──

/**
 * 图片缩放适配。
 *
 * 0.80.3 起上游签名为 `resizeImage(inputBytes: Uint8Array, mimeType, options?)`
 * （0.70.x 是 `(img: ImageContent, options?)`），且内部吞错返回 null。
 * Hana 消费侧（core/model-image-preprocess.ts）契约保持不变：
 * 传 `{data: base64, mimeType}` 对象，本层负责解码与拆参。
 * 返回结构 `ResizedImage` 两版一致，null 仍表示"压不进 maxBytes / 解码失败"。
 *
 * @param {{type?: string, data: string, mimeType?: string}} image
 * @param {{maxWidth?: number, maxHeight?: number, maxBytes?: number, jpegQuality?: number}} options
 */
export async function resizeModelImageInput(image, options) {
  const inputBytes = Buffer.from(String(image?.data ?? ""), "base64");
  return rawResizeImage(inputBytes, image?.mimeType, options);
}

/**
 * @param {{wasResized?: boolean, originalWidth: number, originalHeight: number, width: number, height: number}} result
 */
export function formatModelImageDimensionNote(result) {
  return rawFormatDimensionNote(result);
}

/**
 * ModelRegistry 工厂。
 * 0.64.0 将构造函数私有化；0.80.8 起 registry 只是 ModelRuntime 的同步门面，
 * 由 runtime 构造。下次 SDK 改工厂签名，只改这里。
 */
export function createModelRegistry(runtime: ModelRuntime): ModelRegistry {
  const registry = new ModelRegistry(runtime);
  runtimeByRegistry.set(registry, runtime);
  return registry;
}

/** The runtime a Hana-created registry fronts; undefined for foreign objects. */
export function getModelRegistryRuntime(registry): ModelRuntime | undefined {
  return registry ? runtimeByRegistry.get(registry) : undefined;
}

// ── Agent stream function（0.81+ 属性名 streamFunction）──
export { getAgentStreamFn, setAgentStreamFn } from "./agent-stream.ts";

/**
 * Register a provider through the ModelRegistry instance that owns Hana's
 * AuthStorage. This is intentionally kept at the adapter boundary: importing
 * pi-ai's module-level OAuth registry would target a different nested package
 * instance and the login provider would be invisible to AuthStorage.
 */
export function registerModelProvider(
  modelRegistry: ModelRegistry,
  providerId: string,
  config: SdkProviderRegistrationConfig,
): void {
  modelRegistry.registerProvider(providerId, config);
}

/** Remove a provider previously registered through registerModelProvider. */
export function unregisterModelProvider(
  modelRegistry: ModelRegistry,
  providerId: string,
): void {
  modelRegistry.unregisterProvider(providerId);
}

/**
 * 强制 session 重新绑定当前 model 对象。
 *
 * 为什么需要：Pi SDK 的 model 对象把 baseUrl 烤在字段里
 * （openai-completions.js 等 provider 直接读 model.baseUrl 构造 client），
 * session 持有的是创建时的对象引用。当 ModelRegistry.refresh() 重建模型
 * 表后，session 仍指向旧对象，导致改完 base_url / api 等字段后 active
 * session 用旧值发请求，必须重启或切换 session 才生效。
 *
 * SDK 内部有 _refreshCurrentModelFromRegistry()，但只在 extension
 * registerProvider/unregisterProvider 时被调用，没有公开包装。
 * 这里走 adapter 纪律统一桥接，下次 SDK 升级改名只改这里。
 *
 * 当 Hana 已经从自己的 allowlist 解析出 `allowedModel` 时，直接绑定该
 * ModelRegistry 刷新后对象；这避免 Pi 的私有刷新方法在 Hana 已禁用模型时
 * 找到并保留 Pi 内置目录中的同名模型。未传第二参数时保留旧 adapter 行为。
 *
 * @param {object} session - AgentSession 实例
 * @param {object} [allowedModel] - Hana 当前 allowlist 中、与 session 同身份的模型对象
 * @returns {boolean} 是否完成了刷新/重绑
 */
export function refreshSessionModelFromRegistry(session, allowedModel) {
  if (allowedModel !== undefined) {
    const currentModel = session?.model;
    if (!currentModel || !allowedModel
      || currentModel.id !== allowedModel.id
      || currentModel.provider !== allowedModel.provider
      || !session?.agent?.state) {
      return false;
    }
    session.agent.state.model = allowedModel;
    return true;
  }
  session?._refreshCurrentModelFromRegistry?.();
  return true;
}
