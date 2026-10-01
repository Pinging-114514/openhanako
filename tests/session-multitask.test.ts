import { describe, expect, it } from "vitest";
import {
  buildMultitaskHandoffPrompt,
  extractLastTurnTexts,
  summarizeMultitaskLabel,
} from "../core/session-multitask.ts";

describe("session multitask handoff helpers", () => {
  it("keeps assistant text from the current user turn only", () => {
    expect(extractLastTurnTexts([
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      { role: "user", text: "fix the login copy" },
      { role: "assistant", content: [{ type: "text", text: "editing the button" }] },
    ])).toEqual({
      userText: "fix the login copy",
      assistantText: "editing the button",
    });
  });

  it("does not reuse the previous answer when the current turn is only tools", () => {
    const progress = extractLastTurnTexts([
      { role: "user", content: "old request" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: "current request" },
      { role: "assistant", content: [{ type: "toolCall", name: "edit", id: "x", arguments: { path: "secret" } }] },
      { role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "current file already edited" }] },
    ]);
    expect(progress.userText).toBe("current request");
    expect(progress.assistantText).toBe("edit: current file already edited");
    expect(progress.assistantText).not.toContain("old answer");
    expect(progress.assistantText).not.toContain("secret");
  });

  it("bounds a long completed tool result and ignores an unfinished call", () => {
    const progress = extractLastTurnTexts([
      { role: "user", content: "current request" },
      { role: "assistant", content: [{ type: "toolCall", name: "read", id: "pending" }] },
      { role: "toolResult", toolCallId: "done", toolName: "grep", content: "g".repeat(2000) },
    ]);
    expect(progress.assistantText.startsWith("grep: ggg")).toBe(true);
    expect(progress.assistantText.length).toBeLessThanOrEqual(4000);
    expect(progress.assistantText).not.toContain("read:");
  });

  it("builds a sibling continuation prompt that must not report back", () => {
    const prompt = buildMultitaskHandoffPrompt("fix login", "edited button");
    expect(prompt).toContain("Original request:\nfix login");
    expect(prompt).toContain("Progress so far:\nedited button");
    expect(prompt).toMatch(/do not report back/i);
  });

  it("labels the activity card from the first line", () => {
    expect(summarizeMultitaskLabel("fix login\nthen tests")).toBe("fix login");
  });
});
