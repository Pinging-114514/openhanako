/**
 * Codex OAuth speed tiers ("速度" in the Codex app).
 *
 * The ChatGPT Codex backend does not accept the documented `fast` string;
 * Codex CLI itself rewrites its `service_tier = "fast"` config to `priority`
 * before the request goes out (codex-rs config_types.rs), and `ultrafast` is
 * the separate Cerebras tier. Hana keeps the user-facing names and maps them
 * to the wire values here. Only Codex OAuth (`openai-codex-responses`) uses
 * this; API-key OpenAI has its own paid `service_tier` semantics.
 */

export const CODEX_SERVICE_TIERS = ["standard", "fast", "ultrafast"] as const;
export type CodexServiceTier = typeof CODEX_SERVICE_TIERS[number];

export const DEFAULT_CODEX_SERVICE_TIER: CodexServiceTier = "standard";

const CODEX_OAUTH_PROVIDERS = new Set(["openai-codex", "openai-codex-oauth"]);

/** ChatGPT / Codex OAuth providers that honor the speed-tier preference. */
export function isCodexOauthProvider(provider: unknown): boolean {
  return typeof provider === "string" && CODEX_OAUTH_PROVIDERS.has(provider);
}

const WIRE_VALUES: Record<CodexServiceTier, string | null> = {
  standard: null,
  fast: "priority",
  ultrafast: "ultrafast",
};

export function normalizeCodexServiceTier(value: unknown): CodexServiceTier {
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (lower === "priority") return "fast";
  return (CODEX_SERVICE_TIERS as readonly string[]).includes(lower)
    ? lower as CodexServiceTier
    : DEFAULT_CODEX_SERVICE_TIER;
}

/** Request-body `service_tier` for a tier; null means the field must be absent. */
export function codexServiceTierWireValue(tier: unknown): string | null {
  return WIRE_VALUES[normalizeCodexServiceTier(tier)];
}
