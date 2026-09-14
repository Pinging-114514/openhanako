const VALID_CALL_PURPOSES = new Set([
  "auxiliary_vision",
  "utility",
  "health_check",
  "summary",
  "chat",
]);

function normalizeCallPurpose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_CALL_PURPOSES.has(normalized) ? normalized : null;
}

export function buildProviderCompatOptions({
  mode = "utility",
  callPurpose,
  explicitMaxTokens,
  outputBudgetSource,
  reasoningLevel,
}: {
  mode?: string;
  callPurpose?: unknown;
  explicitMaxTokens?: number | null;
  outputBudgetSource?: unknown;
  reasoningLevel?: unknown;
} = {}) {
  const normalizedPurpose = normalizeCallPurpose(callPurpose);
  const requestedLevel = typeof reasoningLevel === "string" && reasoningLevel.trim()
    ? reasoningLevel.trim()
    : null;
  return {
    mode,
    ...(requestedLevel
      ? { reasoningLevel: requestedLevel }
      : (mode === "utility" ? { reasoningLevel: "off" } : {})),
    ...(normalizedPurpose ? { callPurpose: normalizedPurpose } : {}),
    ...(explicitMaxTokens !== null && explicitMaxTokens !== undefined ? { outputBudgetSource } : {}),
  };
}
