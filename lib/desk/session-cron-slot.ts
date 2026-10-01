import { SESSION_CRON_WAKE_TYPE } from "./session-cron-wake.ts";

const CONCLUSION_LIMIT = 160;

export function textFromContent(content): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function oneLineConclusion(text): string {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (!line) return "";
  if (line.length <= CONCLUSION_LIMIT) return line;
  return `${line.slice(0, CONCLUSION_LIMIT)}…`;
}

export function isSessionCronWakeMessage(message): boolean {
  return message?.role === "custom" && message?.customType === SESSION_CRON_WAKE_TYPE;
}

export function isSessionCronWakeEntry(entry): boolean {
  return entry?.type === "custom_message" && entry?.customType === SESSION_CRON_WAKE_TYPE;
}

export function anchorEntryIdFromBranch(entries): string | null {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "message"
      && entry.message?.role === "user"
      && typeof entry.id === "string"
      && entry.id
    ) {
      return entry.id;
    }
  }
  return null;
}

/**
 * The cron wake is still the tail of this branch when only its own assistant
 * turn follows it. A later user message means the slot is no longer a suffix.
 */
function wakeJobId(details): string {
  return typeof details?.jobId === "string" && details.jobId.trim() ? details.jobId.trim() : "";
}

function anchorFromWake(entry) {
  return typeof entry?.details?.anchorEntryId === "string" && entry.details.anchorEntryId
    ? entry.details.anchorEntryId
    : null;
}

function isToolUseStop(stopReason): boolean {
  return stopReason === "toolUse" || stopReason === "tool_use";
}

function messageHasToolCall(message): boolean {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((part) => part?.type === "toolCall" || part?.type === "tool_use");
}

function assistantView(message) {
  return {
    text: textFromContent(message?.content).trim(),
    stopReason: typeof message?.stopReason === "string" ? message.stopReason : "",
    hasToolCall: messageHasToolCall(message),
  };
}

function assistantIsFinished(view): boolean {
  return !!view?.text && !isToolUseStop(view.stopReason) && !view.hasToolCall;
}

export function trailingSessionCronSegment(entries, jobId) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const segments = [];
  let assistantViews = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isSessionCronWakeEntry(entry)) {
      const entryJobId = wakeJobId(entry.details);
      const ordered = assistantViews.reverse();
      assistantViews = [];
      const sameJob = !jobId || !entryJobId || entryJobId === jobId;
      if (!sameJob) continue;
      const latest = ordered[ordered.length - 1];
      const completed = assistantIsFinished(latest);
      segments.push({
        wake: entry,
        anchorEntryId: anchorFromWake(entry),
        text: completed
          ? ordered.filter(assistantIsFinished).map((view) => view.text).join("\n")
          : "",
        completed,
      });
      continue;
    }
    if (entry?.type === "message") {
      const role = entry.message?.role;
      if (role === "user") break;
      if (role === "assistant") assistantViews.push(assistantView(entry.message));
    }
  }
  return segments.find((segment) => segment.completed) || null;
}

function cronRangeJobKey(message): string {
  return wakeJobId(message?.details) || "*";
}

function rangeFinishedConclusion(messages, start, end): string {
  let latest = null;
  const finished = [];
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const message = messages[cursor];
    if (message?.role !== "assistant") continue;
    latest = assistantView(message);
    if (assistantIsFinished(latest)) finished.push(latest.text);
  }
  if (!assistantIsFinished(latest)) return "";
  return finished.join("\n");
}

function conclusionOnlyMessage(jobId, text) {
  const bounded = oneLineConclusion(text);
  if (!bounded) return null;
  return {
    role: "custom",
    customType: "session-cron-conclusion",
    content: bounded,
    display: false,
    details: {
      ...(jobId && jobId !== "*" ? { jobId } : {}),
      kind: "previous-conclusion",
    },
  };
}

/**
 * Keep the latest cron round intact. Older rounds of the same job are
 * dropped. Each other job contributes one custom conclusion line, never a
 * shortened assistant message that would orphan its tool results.
 */
export function keepLatestSessionCronRange(messages) {
  if (!Array.isArray(messages)) return messages;
  const ranges = [];
  let index = 0;
  while (index < messages.length) {
    if (!isSessionCronWakeMessage(messages[index])) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < messages.length
      && messages[end]?.role !== "user"
      && !isSessionCronWakeMessage(messages[end])
    ) {
      end += 1;
    }
    ranges.push([index, end]);
    index = end;
  }
  if (ranges.length <= 1) return messages;
  const conclusions = ranges.map((range) => rangeFinishedConclusion(messages, range[0], range[1]));
  const latestFinishedByJob = new Map<string, number>();
  ranges.forEach((range, rangeIndex) => {
    if (!conclusions[rangeIndex]) return;
    latestFinishedByJob.set(cronRangeJobKey(messages[range[0]]), rangeIndex);
  });
  const globalLatest = ranges.length - 1;
  const kept = [];
  let cursor = 0;
  ranges.forEach((range, rangeIndex) => {
    const [start, end] = range;
    while (cursor < start) {
      kept.push(messages[cursor]);
      cursor += 1;
    }
    const jobKey = cronRangeJobKey(messages[start]);
    if (rangeIndex === globalLatest) {
      for (let messageIndex = start; messageIndex < end; messageIndex += 1) kept.push(messages[messageIndex]);
    } else if (latestFinishedByJob.get(jobKey) === rangeIndex) {
      const summary = conclusionOnlyMessage(jobKey, conclusions[rangeIndex]);
      if (summary) kept.push(summary);
    }
    cursor = end;
  });
  while (cursor < messages.length) {
    kept.push(messages[cursor]);
    cursor += 1;
  }
  return kept;
}

function suggestionIdFromDetails(details): string {
  const candidates = [
    details?.suggestionId,
    details?.automationSuggestion?.suggestionId,
    details?.suggestion?.id,
    details?.suggestion?.suggestionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/** Pending automation/cron suggestion the user still has to apply. Confirmed writes stay folded. */
export function isActionableAutomationSuggestion(message): boolean {
  if (message?.role !== "toolResult") return false;
  if (message.toolName !== "automation" && message.toolName !== "cron") return false;
  const action = message.details?.action || message.details?.status;
  if (action !== "pending_update" && action !== "pending_add") return false;
  return suggestionIdFromDetails(message.details).length > 0;
}

export function installSessionCronContextFilter(session) {
  const agent = session?.agent;
  if (!agent || agent.__hanaSessionCronFilter || typeof agent.convertToLlm !== "function") return;
  const original = agent.convertToLlm.bind(agent);
  agent.__hanaSessionCronFilter = true;
  agent.convertToLlm = (messages) => original(keepLatestSessionCronRange(messages));
}

export function planSessionCronDisplay(messages) {
  const hide = new Set<number>();
  const slots = new Map();
  const list = Array.isArray(messages) ? messages : [];
  let index = 0;
  while (index < list.length) {
    const message = list[index];
    if (!isSessionCronWakeMessage(message)) {
      index += 1;
      continue;
    }
    const jobId = typeof message.details?.jobId === "string" && message.details.jobId
      ? message.details.jobId
      : String(message.id || index);
    const anchorEntryId = typeof message.details?.anchorEntryId === "string" && message.details.anchorEntryId
      ? message.details.anchorEntryId
      : null;
    const label = typeof message.details?.displayText === "string" ? message.details.displayText.trim() : "";
    const texts = [];
    let lastStop = "";
    hide.add(index);
    let cursor = index + 1;
    while (cursor < list.length) {
      const next = list[cursor];
      if (next?.role === "user" || isSessionCronWakeMessage(next)) break;
      if (!isActionableAutomationSuggestion(next)) hide.add(cursor);
      if (next?.role === "assistant") {
        lastStop = typeof next.stopReason === "string" ? next.stopReason : "";
        const text = textFromContent(next.content).trim();
        if (text) texts.push(text);
      }
      cursor += 1;
    }
    const text = texts.join("\n\n").trim();
    const stillRunning = lastStop === "toolUse" || lastStop === "tool_use";
    const awaitingAssistant = text.length === 0 && slots.has(jobId);
    if (!stillRunning && !awaitingAssistant) {
      slots.set(jobId, {
        jobId,
        anchorEntryId,
        wakeSourceIndex: index,
        label,
        text,
        timestamp: message.timestamp || null,
      });
    }
    index = cursor;
  }
  return { hide, slots: [...slots.values()] };
}

/** liveJobIds 为 null 表示名单暂时读不到，先保持原样。空集合表示当前没有开着的定时。 */
export function retainLiveCronSlots(slots, liveJobIds) {
  if (!liveJobIds) return slots || [];
  return (slots || []).filter((slot) => liveJobIds.has(slot.jobId));
}

export function placeSessionCronSlots(messages, blocks, slots, pageIncludesEnd, startIdx = 0) {
  const placed = [];
  for (const slot of slots || []) {
    const text = typeof slot.text === "string" && slot.text.trim()
      ? slot.text.trim()
      : (slot.label || "");
    if (!text) continue;
    const wakeSourceIndex = slot.wakeSourceIndex;
    if (typeof wakeSourceIndex !== "number") continue;
    const synthetic: Record<string, unknown> = {
      id: `cron-slot:${slot.jobId}`,
      role: "assistant",
      content: text,
      sourceIndex: wakeSourceIndex,
      ...(slot.label ? { cronSlotLabel: slot.label } : {}),
      ...(slot.timestamp ? { timestamp: slot.timestamp } : {}),
    };
    const hasBefore = messages.some((message) => (
      typeof message?.sourceIndex === "number" && message.sourceIndex < wakeSourceIndex
    ));
    let insertAt = messages.findIndex((message) => (
      typeof message?.sourceIndex === "number" && message.sourceIndex > wakeSourceIndex
    ));
    if (insertAt >= 0 && !hasBefore && startIdx !== 0) continue;
    if (insertAt < 0) {
      if (!(hasBefore && pageIncludesEnd)) continue;
      insertAt = messages.length;
    }
    placed.push({ insertAt, synthetic });
  }
  placed.sort((left, right) => right.insertAt - left.insertAt);
  for (const { insertAt, synthetic } of placed) {
    messages.splice(insertAt, 0, synthetic);
    for (const block of blocks || []) {
      if (typeof block?.afterIndex === "number" && block.afterIndex >= startIdx + insertAt) {
        block.afterIndex += 1;
      }
    }
  }
}
