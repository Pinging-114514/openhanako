/**
 * GPT-6 sampling-parameter cleanup.
 *
 * Protocol problem:
 *   GPT-6 Astra rejects `temperature`, `top_p`, and log-probability options on
 *   every OpenAI surface (Responses, Chat Completions, and the Codex backend,
 *   which answers "invalid codex request"). Generation is steered by
 *   `reasoning.effort` only.
 *
 * This runs as a generic patch, not a provider module: the same model id is
 * reachable through OpenAI, Codex OAuth, and OpenAI-compatible relays, and the
 * first-match provider module for those routes may be someone else's.
 *
 * Deletion condition:
 *   OpenAI documents sampling controls for the GPT-6 family again.
 */

const UNSUPPORTED_FIELDS = ["temperature", "top_p", "top_logprobs", "logprobs"];

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isGpt6Model(model, payload?) {
  const id = lower(model?.id) || lower(payload?.model);
  const slug = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return slug === "gpt-6" || slug.startsWith("gpt-6-") || slug.startsWith("gpt-6.");
}

export function stripGpt6SamplingParameters(payload, model) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (!isGpt6Model(model, payload)) return payload;
  let next = payload;
  for (const field of UNSUPPORTED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
    if (next === payload) next = { ...payload };
    delete next[field];
  }
  if (next !== payload && Array.isArray(next.include)) {
    const include = next.include.filter((item) => item !== "message.output_text.logprobs");
    if (include.length !== next.include.length) next.include = include;
  }
  return next;
}
