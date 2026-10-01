/**
 * OpenAI Codex Responses compatibility layer.
 *
 * Handles models using:
 *   - api === "openai-codex-responses"
 *   - provider ids "openai-codex" / "openai-codex-oauth"
 *
 * Protocol problems:
 *   1. ChatGPT Codex's Responses endpoint does not accept OpenAI public API
 *      output budget fields or temperature controls in Hana's current OAuth route.
 *   2. The speed tier ("速度" in the Codex app) is a request-body `service_tier`
 *      whose accepted values differ from the public API: `fast` is rejected,
 *      Codex CLI itself sends `priority`; `ultrafast` is the Cerebras tier.
 *      Hana carries the user's choice in `options.codexServiceTier` and writes
 *      the wire value here, so the live request and the compaction request for
 *      one session agree.
 *
 * Deletion condition:
 *   - Codex Responses accepts these request fields with the same semantics as
 *     public OpenAI Responses, or
 *   - pi-ai exposes a first-class Codex provider serializer that omits them and
 *     forwards a session-level service tier.
 */

import { codexServiceTierWireValue, isCodexOauthProvider, resolveCodexServiceTier, supportsCodexUltrafastModel } from "../../shared/codex-service-tier.ts";

const CODEX_RESPONSES_API = "openai-codex-responses";
const UNSUPPORTED_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
  "maxOutputTokens",
  "temperature",
];

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.api) !== CODEX_RESPONSES_API) return false;
  const provider = lower(model.provider);
  return provider === "" || isCodexOauthProvider(provider);
}

function stripUnsupportedFields(payload) {
  let changed = false;
  for (const field of UNSUPPORTED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      changed = true;
      break;
    }
  }
  if (!changed) return payload;
  const next = { ...payload };
  for (const field of UNSUPPORTED_FIELDS) {
    delete next[field];
  }
  return next;
}

/** Apply the current account gate again at serialization, including inherited utility payloads. */
function applyServiceTier(payload, model, options) {
  const explicit = !!options && Object.prototype.hasOwnProperty.call(options, "codexServiceTier");
  if (!explicit && payload.service_tier !== "ultrafast") return payload;
  const tier = resolveCodexServiceTier(
    explicit ? options.codexServiceTier : payload.service_tier,
    options?.codexUltrafastEligible === true && (!model?.id || supportsCodexUltrafastModel(model.id)),
    payload.model || model?.id || "",
  );
  const wire = codexServiceTierWireValue(tier);
  const has = Object.prototype.hasOwnProperty.call(payload, "service_tier");
  if (wire === null) {
    if (!has) return payload;
    const { service_tier: _omit, ...rest } = payload;
    return rest;
  }
  if (has && payload.service_tier === wire) return payload;
  return { ...payload, service_tier: wire };
}

export function apply(payload, model?, options?) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return applyServiceTier(stripUnsupportedFields(payload), model, options);
}
