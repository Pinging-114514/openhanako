/**
 * Start Multitasking：把当前回合交接给 isolated 兄弟会话。
 * 父会话随后 abort，跟进队列才能在前台继续。
 * 完成后不 steer 回父会话——和 subagent 交差不是同一件事。
 */

export function extractAgentMessageText(message: any): string {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

const ASSISTANT_ROLES = new Set(["assistant", "model"]);
const TOOL_RESULT_ROLES = new Set(["toolResult", "tool_result", "tool"]);
const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "tool_call", "tool_use", "functionCall", "function_call"]);
const MULTITASK_PROGRESS_MAX_CHARS = 4000;
const MULTITASK_TOOL_RESULT_MAX_CHARS = 500;
const MULTITASK_PROGRESS_PART_LIMIT = 8;

function clipProgressText(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function rememberToolCallNames(message: any, names: Map<string, string>) {
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== "object" || !TOOL_CALL_BLOCK_TYPES.has(part.type)) continue;
    const id = typeof part.id === "string"
      ? part.id
      : typeof part.toolCallId === "string" ? part.toolCallId : "";
    const name = typeof part.name === "string" ? part.name.trim() : "";
    if (id && name) names.set(id, name);
  }
}

function toolResultName(message: any, names: Map<string, string>) {
  if (typeof message?.toolName === "string" && message.toolName.trim()) return message.toolName.trim();
  if (typeof message?.name === "string" && message.name.trim()) return message.name.trim();
  const id = typeof message?.toolCallId === "string" ? message.toolCallId : "";
  return (id && names.get(id)) || "tool";
}

/** Progress for the current user turn only. Earlier assistant text is a different turn. */
function collectCurrentTurnProgress(turnMessages: any[]) {
  const toolNames = new Map<string, string>();
  for (const message of turnMessages) {
    if (ASSISTANT_ROLES.has(message?.role)) rememberToolCallNames(message, toolNames);
  }
  const parts: string[] = [];
  for (const message of turnMessages) {
    const role = message?.role;
    if (ASSISTANT_ROLES.has(role)) {
      const text = extractAgentMessageText(message);
      if (text) parts.push(text);
      continue;
    }
    if (!TOOL_RESULT_ROLES.has(role)) continue;
    const text = extractAgentMessageText(message);
    if (!text) continue;
    parts.push(`${toolResultName(message, toolNames)}: ${clipProgressText(text, MULTITASK_TOOL_RESULT_MAX_CHARS)}`);
  }
  const recent = parts.slice(-MULTITASK_PROGRESS_PART_LIMIT);
  return clipProgressText(recent.join("\n"), MULTITASK_PROGRESS_MAX_CHARS);
}

export function extractLastTurnTexts(messages: any[] = []) {
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return { userText: "", assistantText: "" };
  return {
    userText: extractAgentMessageText(messages[userIndex]),
    assistantText: collectCurrentTurnProgress(messages.slice(userIndex + 1)),
  };
}

export function buildMultitaskHandoffPrompt(userText: string, assistantText = "") {
  const request = String(userText || "").trim();
  const progress = String(assistantText || "").trim().slice(0, 4000);
  const parts = [
    "The user started another task in the original session. Continue the work below on your own.",
    "Do not wait for them, and do not report back to the original session.",
    "",
    "Original request:",
    request,
  ];
  if (progress) {
    parts.push("", "Progress so far:", progress);
  }
  return parts.join("\n");
}

export function summarizeMultitaskLabel(userText: string) {
  const line = String(userText || "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  if (!line) return "multitask";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}
