import type { Observation } from "./types.ts";

const PREAMBLE = `These are condensed memories from earlier in this session.

- Reflections are omitted in this mode; observations are timestamped facts from the conversation.
- Treat these as past records. When they conflict, the most recent observation is the latest known state.
- Work marked completed should not be redone unless the user asks to revisit it.
- Preserve exact file paths, function names, and error messages when present.`;

export function renderObservationalSummary(observations: Observation[]): string {
  const list = Array.isArray(observations) ? observations : [];
  if (list.length === 0) return "";
  const kept = list.slice(-80);
  const lines = kept.map((item) => {
    const mark = item.relevance === "high" ? "high" : item.relevance === "low" ? "low" : "medium";
    return `- [${item.id}] ${item.timestamp} [${mark}] ${item.content}`;
  });
  return `${PREAMBLE}\n\n## Observations\n${lines.join("\n")}`;
}
