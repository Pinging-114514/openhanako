/**
 * 设置页和聊天用的同一套模型卡查找。
 *
 * 顺序：这个供应商自己的分区 → 通用兜底 → 其他供应商里第一张同名卡。
 * 最后一步只给展示和未保存的能力字段用。协议字段（api、thinkingLevelMap、compat）
 * 不能靠这张借来的卡，那条线仍然走 lookupKnownProvider。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookupInSection(section: unknown, modelId: string, bare: string): Record<string, unknown> | null {
  if (!isRecord(section)) return null;
  if (isRecord(section[modelId])) return section[modelId] as Record<string, unknown>;
  if (bare && isRecord(section[bare])) return section[bare] as Record<string, unknown>;
  return null;
}

const PROVIDER_SECTION_ALIASES: Record<string, string[]> = {
  "openai-codex": ["openai-codex-oauth"],
  "openai-codex-oauth": ["openai-codex"],
};

export function lookupReferenceMetadata(
  dict: Record<string, unknown> | null | undefined,
  fallbacks: Record<string, unknown> | null | undefined,
  provider: string | null | undefined,
  modelId: string | null | undefined,
): Record<string, unknown> | null {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  const bare = modelId.includes("/") ? modelId.split("/").pop() || "" : "";

  if (provider && dict) {
    const own = lookupInSection(dict[provider], modelId, bare);
    if (own) return own;
    for (const alias of PROVIDER_SECTION_ALIASES[provider] || []) {
      const aliased = lookupInSection(dict[alias], modelId, bare);
      if (aliased) return aliased;
    }
  }

  const fallback = lookupInSection(fallbacks, modelId, bare);
  if (fallback) return fallback;

  if (!dict) return null;
  for (const [key, section] of Object.entries(dict)) {
    if (key === "_comment" || key === provider) continue;
    const hit = lookupInSection(section, modelId, bare);
    if (hit) return hit;
  }
  return null;
}
