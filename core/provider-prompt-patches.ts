/**
 * Temporary provider prompt patches.
 *
 * Deletion conditions:
 * - DeepSeek: remove when DeepSeek reasoning models reliably keep user-facing
 *   answers in final assistant content across official and third-party providers.
 * - GPT-6: remove when OpenAI's model guidance stops recommending explicit
 *   initiative / approval / testing calibration for the GPT-6 family.
 */

import { isDeepSeekFamilyModel, isDeepSeekReasoningModel } from "../shared/model-capabilities.ts";
import { isGpt6Model } from "./provider-compat/gpt6-sampling.ts";

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function deepseekOutputContractPrompt(locale) {
  const isZh = String(locale || "").startsWith("zh");
  if (!isZh) {
    return [
      "If you are using a DeepSeek model, follow this DeepSeek output contract:",
      "reasoning_content / thinking is only for private reasoning scratch work.",
      "Any user-facing answer, recommendation, code, list, question, summary, or conclusion must be written into the final assistant content after thinking.",
      "Do not end a response with only reasoning_content / thinking.",
      "If you use <think> tags, close the thinking tag before emitting the final answer.",
    ].join("\n");
  }

  return [
    "如果你使用的是 DeepSeek 模型，请遵守以下 DeepSeek 输出契约：",
    "reasoning_content / thinking 只用于内部推理草稿。",
    "任何需要展示给用户的回答、建议、代码、列表、问题、摘要、结论，都必须在思考结束后写入最终 assistant content。",
    "不要只输出 reasoning_content / thinking 就结束本轮回复。",
    "如果使用 <think> 标签，必须先关闭思考标签，再输出最终回答。",
  ].join("\n");
}

/**
 * GPT-6 Astra behaviour calibration, condensed from OpenAI's model guidance for
 * the family: it asks more readily than earlier models, is very sensitive to
 * instruction files, over-tests small changes, and defaults to heavy formatting.
 * The patch tells it how Hana wants those tendencies resolved.
 */
function gpt6BehaviourPrompt(locale) {
  const isZh = String(locale || "").startsWith("zh");
  if (!isZh) {
    return [
      "You are a GPT-6 family model. Calibrate these tendencies for this workspace:",
      "Infer the user's intent and scope from the conversation and bias towards action: when the user asks for work (\"can you\", \"help me\", \"I want to\"), do the work and carry it to completion instead of acknowledging, proposing a plan, or stopping at a partial result.",
      "Ask a question only when the answer could materially change the outcome. Before asking, finish everything already authorized so the user approves a concrete, reviewable result; reversible actions, read-only work, reviews and fixes need no permission.",
      "Do not add unsolicited warnings, disclaimers, approval flows or safety checklists for hypothetical risk.",
      "The user's explicit instructions take precedence over any skill or instruction file. If a skill makes you pause or diverge, name the file and quote the line.",
      "For code changes, run the checks the change actually needs; do not write tests for reversible, low-impact edits that only mirror the implementation, and repeat or broaden testing only when a failure or new change justifies it.",
      "When delegating to other agents would save time or improve quality, delegate; keep messages to other agents legible to a human.",
      "Write in plain, direct language calibrated to the user's background; use lists and tables only when the content is genuinely parallel or comparative, and avoid stock phrases and contrastive framing.",
    ].join("\n");
  }
  return [
    "你是 GPT-6 系列模型。在这个工作区里按下面的方式校准你的习惯：",
    "从对话推断用户的意图和范围，倾向于行动：用户表达要做某件事（「能不能」「帮我」「我想」）时，直接把事做完，不要停在「可以」、只给方案、或者做一半。",
    "只有答案会实质改变结果时才提问。提问之前先把已经授权的部分做完，让用户审的是一个具体、可检查的成果；可逆操作、只读操作、审查和修复不需要征求许可。",
    "不要因为假设性风险主动加免责声明、审批流程或安全清单。",
    "用户的明确指示优先于任何技能或指令文件。如果某个技能让你停下或偏离，说出是哪个文件、引用那一句。",
    "改代码时只跑这次改动真正需要的检查；可逆、影响小、只是照抄实现的改动不要写测试；只有出现失败或新改动时才扩大或重复测试。",
    "委派给其他 agent 能省时间或提高质量时就委派；给其他 agent 的消息要让人能读。",
    "用直白的语言，按用户的背景调整深浅；只有内容确实并列或需要比较时才用列表和表格；不用套话，不用「不是 X 而是 Y」这种对比句式。",
  ].join("\n");
}

export function getProviderPromptPatches(model, options: { reasoningLevel?: any; locale?: any } = {}) {
  const patches: string[] = [];
  if (isGpt6Model(model)) {
    patches.push(gpt6BehaviourPrompt(options.locale));
  }
  if (!isThinkingOff(options.reasoningLevel) && isDeepSeekReasoningModel(model)) {
    patches.push(deepseekOutputContractPrompt(options.locale));
  }
  return patches;
}

export const _test = {
  isDeepSeekFamilyModel,
  isDeepSeekReasoningModel,
  isGpt6Model,
};
