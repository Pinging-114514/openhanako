import { describe, expect, it, vi } from "vitest";
import {
  ASK_USER_OTHER_ID,
  createAskUserTool,
  parseAskUserParams,
  sanitizeAskUserAnswer,
} from "../lib/tools/ask-user-tool.ts";
import { ConfirmStore } from "../lib/confirm-store.ts";

const OPTIONS = [
  { id: "plan_a", label: "Plan A", description: "Ship now" },
  { id: "plan_b", label: "Plan B" },
];

function runtimeCtx(sessionPath = "/sessions/current.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
    },
  };
}

function validParams(overrides: Record<string, unknown> = {}) {
  return {
    question: "Which plan?",
    options: OPTIONS,
    allow_multiple: false,
    ...overrides,
  };
}

describe("parseAskUserParams", () => {
  it("requires question, 2–4 options, and allow_multiple", () => {
    expect(parseAskUserParams({})).toEqual({ error: "question is required" });
    expect(parseAskUserParams({ question: "Q" })).toMatchObject({
      error: "allow_multiple is required: false for one choice, true for multiple",
    });
    expect(parseAskUserParams({
      question: "Q",
      allow_multiple: false,
      options: [{ id: "a", label: "A" }],
    })).toMatchObject({ error: expect.stringContaining("2–4") });
  });

  it("rejects reserved other id and duplicate ids", () => {
    expect(parseAskUserParams({
      question: "Q",
      allow_multiple: false,
      options: [
        { id: ASK_USER_OTHER_ID, label: "X" },
        { id: "b", label: "B" },
      ],
    })).toMatchObject({ error: expect.stringContaining("reserved") });
    expect(parseAskUserParams({
      question: "Q",
      allow_multiple: true,
      options: [
        { id: "a", label: "A" },
        { id: "a", label: "Again" },
      ],
    })).toMatchObject({ error: "duplicate option id: a" });
  });

  it("accepts a valid single-choice payload", () => {
    expect(parseAskUserParams(validParams())).toEqual({
      question: "Which plan?",
      allowMultiple: false,
      options: OPTIONS,
    });
  });
});

describe("sanitizeAskUserAnswer", () => {
  it("drops unknown ids and enforces single select", () => {
    expect(sanitizeAskUserAnswer(
      { selected: ["plan_a", "nope", "plan_b"], free_text: "  mine  " },
      OPTIONS,
      false,
    )).toEqual({ selected: ["plan_a"], free_text: "mine" });
  });

  it("keeps multiple valid ids when allowed", () => {
    expect(sanitizeAskUserAnswer(
      { selected: ["plan_b", "plan_a", "plan_a"] },
      OPTIONS,
      true,
    )).toEqual({ selected: ["plan_b", "plan_a"] });
  });
});

describe("ask_user tool", () => {
  it("declares a read permission boundary", () => {
    const tool = createAskUserTool();
    expect(tool.name).toBe("ask_user");
    expect(tool.sessionPermission.resolveInvocation()).toEqual({
      action: "prompt",
      kind: "read",
      capability: "ask_user.prompt",
    });
    expect(tool.parameters.required).toEqual(expect.arrayContaining([
      "question",
      "options",
      "allow_multiple",
    ]));
  });

  it("returns a single-choice answer after confirm", async () => {
    const store = new ConfirmStore();
    const emitEvent = vi.fn();
    const tool = createAskUserTool({
      getConfirmStore: () => store,
      emitEvent,
    });

    const pending = tool.execute("call_1", validParams(), runtimeCtx());
    await vi.waitFor(() => expect(store.size).toBe(1));
    const confirmId = [...(store as any)._pending.keys()][0];
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "user_choice",
      confirmId,
      question: "Which plan?",
      allowMultiple: false,
    }), "/sessions/current.jsonl");

    store.resolve(confirmId, "confirmed", { selected: ["plan_a"] });
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ selected: ["plan_a"] });
    expect(result.details).toMatchObject({
      confirmId,
      status: "answered",
      allowMultiple: false,
      answer: { selected: ["plan_a"] },
    });
  });

  it("returns multiple selected ids and free text", async () => {
    const store = new ConfirmStore();
    const tool = createAskUserTool({ confirmStore: store });
    const pending = tool.execute(
      "call_2",
      validParams({ allow_multiple: true }),
      runtimeCtx(),
    );
    await vi.waitFor(() => expect(store.size).toBe(1));
    const confirmId = [...(store as any)._pending.keys()][0];
    store.resolve(confirmId, "confirmed", {
      selected: ["plan_a", "plan_b"],
      free_text: "also C",
    });
    const result = await pending;
    expect(result.details.answer).toEqual({
      selected: ["plan_a", "plan_b"],
      free_text: "also C",
    });
  });

  it("maps skip and timeout to skipped answers", async () => {
    const store = new ConfirmStore();
    const tool = createAskUserTool({ confirmStore: store });
    const pending = tool.execute("call_3", validParams(), runtimeCtx());
    await vi.waitFor(() => expect(store.size).toBe(1));
    store.resolve([...(store as any)._pending.keys()][0], "rejected");
    const result = await pending;
    expect(result.details.status).toBe("skipped");
    expect(result.details.answer).toEqual({ selected: [], skipped: true });
  });

  it("rejects a second pending card in the same session", async () => {
    const store = new ConfirmStore();
    const tool = createAskUserTool({ confirmStore: store });
    const first = tool.execute("call_4", validParams(), runtimeCtx());
    await vi.waitFor(() => expect(store.size).toBe(1));
    const second = await tool.execute("call_5", validParams(), runtimeCtx());
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("already pending");
    store.resolve([...(store as any)._pending.keys()][0], "confirmed", { selected: ["plan_b"] });
    await first;
  });

  it("errors when the desktop confirm surface is missing", async () => {
    const tool = createAskUserTool();
    const result = await tool.execute("call_6", validParams(), runtimeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("desktop chat UI");
  });
});
