/**
 * Meta Model API (Muse Spark)
 *
 * 文档：https://ai.developer.meta.com/docs/models
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const metaPlugin = {
  id: "meta",
  displayName: "Meta (Muse)",
  authType: "api-key",
  defaultBaseUrl: "https://api.meta.ai/v1",
  defaultApi: "openai-responses",
};
