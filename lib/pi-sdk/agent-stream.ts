/**
 * Agent stream function accessors.
 *
 * pi-agent-core 0.81 renamed the `Agent` property `streamFn` to
 * `streamFunction`; the loop only reads the new name, so assigning the old one
 * silently installs nothing. Hana wraps this function in several places
 * (assistant stream guard, retry policy, cache-prefix guard, provider cache
 * affinity), so every read and write goes through these two helpers. The old
 * property name is honoured only as a fallback for test doubles.
 */

export function getAgentStreamFn(agent) {
  if (!agent || typeof agent !== "object") return null;
  if (typeof agent.streamFunction === "function") return agent.streamFunction;
  if (typeof agent.streamFn === "function") return agent.streamFn;
  return null;
}

export function setAgentStreamFn(agent, fn) {
  if (!agent || typeof agent !== "object") return;
  if ("streamFunction" in agent || typeof agent.streamFn !== "function") {
    agent.streamFunction = fn;
  } else {
    agent.streamFn = fn;
  }
}
