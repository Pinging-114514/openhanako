import { lookupKnown } from "../shared/known-models.ts";
import { findModel, parseModelRef, requireModelRef } from "../shared/model-ref.ts";
import { getModelThinkingLevels, resolveModelDefaultThinkingLevel } from "./session-thinking-level.ts";

export const SAMPLE_TEXT_UTILITY_ROLES = ["utility", "utility_large"] as const;
export type SampleTextUtilityRole = (typeof SAMPLE_TEXT_UTILITY_ROLES)[number];

function sampleTextModelRaw(payload: any = {}) {
  return payload?.model ?? payload?.modelId ?? payload?.modelKey ?? payload?.role;
}

export function resolveSampleTextUtilityRole(payload: any = {}): SampleTextUtilityRole {
  const raw = sampleTextModelRaw(payload);
  return raw === "utility_large" ? "utility_large" : "utility";
}

export function resolveSampleTextModelRef(payload: any = {}) {
  const raw = sampleTextModelRaw(payload);
  if (raw == null || raw === "" || (SAMPLE_TEXT_UTILITY_ROLES as readonly string[]).includes(raw)) return null;
  return requireModelRef(typeof raw === "string" ? parseModelRef(raw) : raw);
}

export function publicAvailableModel(model: any) {
  if (!model?.id || !model?.provider) return null;
  return {
    key: `${model.provider}/${model.id}`,
    id: model.id,
    provider: model.provider,
    name: model.name || model.id,
    thinkingLevels: getModelThinkingLevels(model) || [],
    defaultThinkingLevel: resolveModelDefaultThinkingLevel(model),
  };
}

function sharedModelRef(shared) {
  if (!shared) return null;
  if (typeof shared === "string") return parseModelRef(shared);
  if (typeof shared === "object" && typeof shared.id === "string" && shared.id.trim()) {
    return {
      id: shared.id.trim(),
      provider: typeof shared.provider === "string" ? shared.provider.trim() : "",
    };
  }
  return null;
}

function resolveSharedLiveModel(shared, availableModels = []) {
  const ref = sharedModelRef(shared);
  if (!ref?.id) return null;
  if (ref.provider) {
    return findModel(availableModels, ref.id, ref.provider)
      || { id: ref.id, provider: ref.provider, name: lookupKnown(ref.provider, ref.id)?.name };
  }
  const matches = (availableModels || []).filter((model) => model?.id === ref.id);
  return matches.length === 1 ? matches[0] : { id: ref.id, provider: "", name: ref.id };
}

export function publicUtilityRoleRow(role, title, shared, availableModels = []) {
  if (role !== "utility" && role !== "utility_large") return null;
  const live = resolveSharedLiveModel(shared, availableModels);
  const published = publicAvailableModel(live);
  const currentName = published?.name || live?.name || null;
  return {
    key: role,
    id: role,
    provider: "system",
    role,
    name: currentName ? `${title} · ${currentName}` : title,
    currentName,
    modelKey: published?.key || "",
    thinkingLevels: published?.thinkingLevels || (live ? getModelThinkingLevels(live) : []) || [],
    defaultThinkingLevel: published?.defaultThinkingLevel || (live ? resolveModelDefaultThinkingLevel(live) : null),
  };
}

export function publicUtilityRoles(sharedModels = {}, availableModels = []) {
  return {
    utility: publicUtilityRoleRow("utility", "小工具模型", sharedModels?.utility, availableModels),
    utility_large: publicUtilityRoleRow("utility_large", "大工具模型", sharedModels?.utility_large, availableModels),
  };
}
