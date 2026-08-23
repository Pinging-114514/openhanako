import { lookupKnown } from "../shared/known-models.ts";

export const DEFAULT_SESSION_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_VISIBLE_THINKING_LEVELS = ["off", "medium", "high"];
const OPENAI_XHIGH_MODEL_MARKERS = [
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.5",
];
const ANTHROPIC_XHIGH_MODEL_MARKERS = [
  "opus-5",
  "sonnet-5",
  "fable-5",
  "mythos-5",
  "opus-4-7",
  "opus-4.7",
  "sonnet-4-7",
  "sonnet-4.7",
];
const ANTHROPIC_MAX_EFFORT_MODEL_MARKERS = [
  "opus-5",
  "sonnet-5",
  "fable-5",
  "mythos-5",
  "opus-4-6",
  "opus-4.6",
  "opus-4-7",
  "opus-4.7",
  "sonnet-4-6",
  "sonnet-4.6",
];
const GROK_XHIGH_MODEL_MARKERS = [
  "grok-4.6",
];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function canonicalThinkingLevel(level) {
  const normalized = lower(level);
  if (normalized === "auto") return "medium";
  if (normalized === "ultracode") return "max";
  return VALID_THINKING_LEVELS.has(normalized) ? normalized : null;
}

export function normalizeThinkingLevelChoices(levels) {
  if (!Array.isArray(levels)) return null;
  const out = [];
  for (const rawLevel of levels) {
    const normalized = canonicalThinkingLevel(rawLevel);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out.length > 0 ? out : null;
}

export function normalizeSessionThinkingLevel(level) {
  return canonicalThinkingLevel(level) || DEFAULT_SESSION_THINKING_LEVEL;
}

export function normalizeRequestThinkingLevel(level, fallback = "off") {
  return canonicalThinkingLevel(level)
    || canonicalThinkingLevel(fallback)
    || "off";
}

export function normalizePiSdkThinkingLevel(level) {
  return normalizeRequestThinkingLevel(level, "off");
}

function idIncludesAny(id, markers) {
  return markers.some((marker) => id.includes(marker));
}

function modelUsesAnthropicEffortControl(model) {
  const provider = lower(model?.provider);
  const api = lower(model?.api);
  const baseUrl = lower(model?.baseUrl || model?.base_url);
  return provider === "anthropic"
    || api === "anthropic-messages"
    || baseUrl.includes("api.anthropic.com");
}

export function modelSupportsAnthropicMaxEffort(model) {
  const id = lower(model?.id);
  return modelUsesAnthropicEffortControl(model)
    && idIncludesAny(id, ANTHROPIC_MAX_EFFORT_MODEL_MARKERS);
}

function modelSupportsAnthropicXhigh(model) {
  const id = lower(model?.id);
  return modelUsesAnthropicEffortControl(model)
    && idIncludesAny(id, ANTHROPIC_XHIGH_MODEL_MARKERS);
}

function knownOf(model) {
  return lookupKnown(model?.provider, model?.id);
}

function explicitLevelsOf(model) {
  return normalizeThinkingLevelChoices(model?.thinkingLevels)
    || normalizeThinkingLevelChoices(knownOf(model)?.thinkingLevels);
}

export function modelSupportsXhigh(model) {
  const explicitLevels = explicitLevelsOf(model);
  if (explicitLevels) return explicitLevels.includes("xhigh");
  const known = knownOf(model);
  return typeof model?.thinkingLevelMap?.xhigh === "string"
    || typeof known?.thinkingLevelMap?.xhigh === "string"
    || model?.xhigh === true
    || known?.xhigh === true
    || idIncludesAny(lower(model?.id), OPENAI_XHIGH_MODEL_MARKERS)
    || idIncludesAny(lower(model?.id), GROK_XHIGH_MODEL_MARKERS)
    || modelSupportsAnthropicXhigh(model);
}

export function modelSupportsMax(model) {
  const explicitLevels = explicitLevelsOf(model);
  if (explicitLevels) return explicitLevels.includes("max");
  const known = knownOf(model);
  return typeof model?.thinkingLevelMap?.max === "string"
    || typeof known?.thinkingLevelMap?.max === "string"
    || modelSupportsAnthropicMaxEffort(model);
}

export function getModelThinkingLevels(model) {
  const explicitLevels = normalizeThinkingLevelChoices(model?.thinkingLevels)
    || normalizeThinkingLevelChoices(knownOf(model)?.thinkingLevels);
  if (explicitLevels) return explicitLevels;
  const levels = [...DEFAULT_VISIBLE_THINKING_LEVELS];
  if (modelSupportsXhigh(model)) levels.push("xhigh");
  if (modelSupportsMax(model) && !levels.includes("max")) levels.push("max");
  return levels;
}

function mappedVisibleLevel(level, model, available) {
  const map = model?.thinkingLevelMap || knownOf(model)?.thinkingLevelMap;
  if (!map || typeof map !== "object") return null;
  const mapped = map[level];
  if (typeof mapped !== "string") return null;
  const canonical = canonicalThinkingLevel(mapped) || mapped;
  return available.includes(canonical) ? canonical : null;
}

export function normalizeThinkingLevelForModel(level, model) {
  if (lower(level) === "auto") {
    return resolveModelDefaultThinkingLevel(model);
  }
  return normalizeCanonicalThinkingLevelForModel(level, model);
}

function normalizeCanonicalThinkingLevelForModel(level, model) {
  const normalized = normalizeSessionThinkingLevel(level);
  const explicitLevels = getModelThinkingLevels(model);
  if (explicitLevels.includes(normalized)) return normalized;
  // Old UI stored the unified Max chip as "max" even when the model only has xhigh.
  if (normalized === "max" && explicitLevels.includes("xhigh") && !explicitLevels.includes("max")) {
    return "xhigh";
  }
  const mapped = mappedVisibleLevel(normalized, model, explicitLevels);
  if (mapped) return mapped;
  if ((normalized === "xhigh" || normalized === "max") && explicitLevels.includes("high")) return "high";
  if (VALID_THINKING_LEVELS.has(normalized) && !normalizeThinkingLevelChoices(model?.thinkingLevels) && !normalizeThinkingLevelChoices(knownOf(model)?.thinkingLevels)) {
    if (normalized === "xhigh" && !modelSupportsXhigh(model)) return "high";
    if (normalized === "max" && !modelSupportsMax(model)) return "high";
    return normalized;
  }
  const defaultVisible = canonicalThinkingLevel(model?.defaultThinkingLevel);
  if (defaultVisible && explicitLevels.includes(defaultVisible)) return defaultVisible;
  if (explicitLevels.includes(DEFAULT_SESSION_THINKING_LEVEL)) return DEFAULT_SESSION_THINKING_LEVEL;
  return explicitLevels[0];
}

export function resolveModelDefaultThinkingLevel(model, fallback = DEFAULT_SESSION_THINKING_LEVEL) {
  const declaredLevel = typeof model?.defaultThinkingLevel === "string"
    && lower(model.defaultThinkingLevel) !== "auto"
    ? model.defaultThinkingLevel
    : fallback;
  return normalizeCanonicalThinkingLevelForModel(declaredLevel, model);
}

export function resolveThinkingLevelForModel(level, model, resolveThinkingLevel = (value) => value) {
  return resolveThinkingLevel(normalizeThinkingLevelForModel(level, model));
}
