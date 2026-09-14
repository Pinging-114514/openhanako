/**
 * ask-user-tool.ts — 对话内让用户选方案
 *
 * 单问、2–4 个选项。allow_multiple 区分单选 / 多选。
 * UI 自动加「其他…」自由输入。停轮复用 ConfirmStore。
 * 卡片钉在对话里，不走输入栏权限卡。
 */

import { Type } from "../pi-sdk/index.ts";
import { getToolSessionPath, normalizeToolRuntimeContext } from "./tool-session.ts";
import { toolError, toolOk } from "./tool-result.ts";

export const ASK_USER_TOOL_NAME = "ask_user";
export const ASK_USER_OTHER_ID = "__other__";
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 4;

export type AskUserOption = {
  id: string;
  label: string;
  description?: string;
};

export type AskUserAnswer = {
  selected: string[];
  free_text?: string;
  skipped?: true;
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAskUserParams(params: any = {}) {
  const question = nonEmptyString(params?.question);
  if (!question) return { error: "question is required" };
  if (typeof params?.allow_multiple !== "boolean") {
    return { error: "allow_multiple is required: false for one choice, true for multiple" };
  }
  if (!Array.isArray(params.options)) {
    return { error: `options must contain ${ASK_USER_MIN_OPTIONS}–${ASK_USER_MAX_OPTIONS} items` };
  }
  if (
    params.options.length < ASK_USER_MIN_OPTIONS
    || params.options.length > ASK_USER_MAX_OPTIONS
  ) {
    return { error: `options must contain ${ASK_USER_MIN_OPTIONS}–${ASK_USER_MAX_OPTIONS} items` };
  }

  const seen = new Set<string>();
  const options: AskUserOption[] = [];
  for (const raw of params.options) {
    const id = nonEmptyString(raw?.id);
    const label = nonEmptyString(raw?.label);
    const description = nonEmptyString(raw?.description);
    if (!id || !label) return { error: "each option needs id and label" };
    if (id === ASK_USER_OTHER_ID) return { error: `${ASK_USER_OTHER_ID} is reserved for the UI Other field` };
    if (seen.has(id)) return { error: `duplicate option id: ${id}` };
    seen.add(id);
    options.push(description ? { id, label, description } : { id, label });
  }

  return {
    question,
    allowMultiple: params.allow_multiple === true,
    options,
  };
}

export function sanitizeAskUserAnswer(
  value: any,
  options: AskUserOption[],
  allowMultiple: boolean,
): AskUserAnswer {
  const allowed = new Set(options.map((option) => option.id));
  const selected = Array.isArray(value?.selected)
    ? [...new Set(
      value.selected.filter((id: unknown) => typeof id === "string" && allowed.has(id)),
    )]
    : [];
  if (!allowMultiple && selected.length > 1) selected.length = 1;
  const freeText = nonEmptyString(value?.free_text);
  return {
    selected,
    ...(freeText ? { free_text: freeText } : {}),
  };
}

function skippedAnswer(): AskUserAnswer {
  return { selected: [], skipped: true };
}

function formatAnswerText(answer: AskUserAnswer): string {
  return JSON.stringify(answer);
}

function attachAbort(signal: any, onAbort: () => void) {
  if (!signal || typeof signal.addEventListener !== "function") return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * @param {{
 *   getConfirmStore?: () => any,
 *   confirmStore?: any,
 *   emitEvent?: (event: object, sessionPath: string) => void,
 * }} [options]
 */
export function createAskUserTool(options: any = {}) {
  return {
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user to pick from 2–4 options. Set allow_multiple to false for a single choice, or true to allow more than one. "
      + "The chat UI always adds an Other field for free text. The call waits until the user submits or skips. "
      + "Do not use show_card for choices.",
    parameters: Type.Object({
      question: Type.String({
        description: "The question shown on the card.",
      }),
      options: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable option id returned in the tool result." }),
          label: Type.String({ description: "Option text shown to the user." }),
          description: Type.Optional(Type.String({
            description: "Optional one-line explanation under the label.",
          })),
        }),
        {
          minItems: ASK_USER_MIN_OPTIONS,
          maxItems: ASK_USER_MAX_OPTIONS,
          description: "Two to four choices. The UI adds Other automatically.",
        },
      ),
      allow_multiple: Type.Boolean({
        description: "false = one option; true = the user may pick more than one.",
      }),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "prompt",
        kind: "read",
        capability: "ask_user.prompt",
      }),
    },
    progress: "正在等你选",
    execute: async (toolCallId: string, params: any, signalOrCtx?: any, _onUpdate?: any, piCtx?: any) => {
      const parsed = parseAskUserParams(params);
      if ("error" in parsed) return toolError(parsed.error);

      const { ctx } = normalizeToolRuntimeContext(signalOrCtx, piCtx);
      const sessionPath = getToolSessionPath(ctx);
      const confirmStore = options.getConfirmStore?.() || options.confirmStore || null;
      if (!confirmStore || !sessionPath) {
        return toolError("ask_user needs the desktop chat UI.");
      }
      if (typeof confirmStore.hasPending === "function" && confirmStore.hasPending("user_choice", sessionPath)) {
        return toolError("ask_user already pending in this session; wait for the user to answer first.");
      }

      const { confirmId, promise } = confirmStore.create(
        "user_choice",
        {
          question: parsed.question,
          options: parsed.options,
          allowMultiple: parsed.allowMultiple,
        },
        sessionPath,
      );

      const detachAbort = attachAbort(signalOrCtx, () => {
        if (!confirmStore.resolve?.(confirmId, "rejected")) return;
        options.emitEvent?.({
          type: "confirmation_resolved",
          confirmId,
          action: "rejected",
          value: { selected: [], skipped: true },
        }, sessionPath);
      });

      options.emitEvent?.({
        type: "user_choice",
        confirmId,
        question: parsed.question,
        options: parsed.options,
        allowMultiple: parsed.allowMultiple,
      }, sessionPath);

      let decision: any;
      try {
        decision = await promise;
      } finally {
        detachAbort();
      }

      const detailsBase = {
        confirmId,
        question: parsed.question,
        options: parsed.options,
        allowMultiple: parsed.allowMultiple,
      };

      if (decision?.action !== "confirmed") {
        const answer = skippedAnswer();
        const status = decision?.action === "timeout" ? "timeout" : "skipped";
        return toolOk(formatAnswerText(answer), {
          ...detailsBase,
          status,
          answer,
        });
      }

      const answer = sanitizeAskUserAnswer(decision.value, parsed.options, parsed.allowMultiple);
      if (answer.selected.length === 0 && !answer.free_text) {
        const skipped = skippedAnswer();
        return toolOk(formatAnswerText(skipped), {
          ...detailsBase,
          status: "skipped",
          answer: skipped,
        });
      }

      return toolOk(formatAnswerText(answer), {
        ...detailsBase,
        status: "answered",
        answer,
      });
    },
  };
}
