/**
 * Grok CLI chat-proxy request markers for xai-oauth.
 *
 * cli-chat-proxy.grok.com requires these headers. On 2026-10-01, the same
 * active OAuth credential returned HTTP 426 for 0.2.95 (minimum 1.0.13),
 * and HTTP 200/completed for 1.0.13. Keep chat, billing, and native-search
 * markers on this shared constant; future floor changes need a live probe.
 */

export const GROK_CLI_CLIENT_VERSION = "1.0.13";
export const GROK_CLI_CLIENT_IDENTIFIER = "hana";

export function buildXaiOauthCliProviderHeaders(): Record<string, string> {
  return {
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": GROK_CLI_CLIENT_VERSION,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
  };
}

export function buildXaiOauthCliModelHeaders(modelId: string): Record<string, string> {
  const id = String(modelId || "").trim().toLowerCase().split("/").pop() || "";
  if (!id) return {};
  return { "x-grok-model-override": id };
}
