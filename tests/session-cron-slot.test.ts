import { describe, expect, it } from "vitest";
import { extractBlocks } from "../server/block-extractors.ts";
import {
  anchorEntryIdFromBranch,
  keepLatestSessionCronRange,
  oneLineConclusion,
  placeSessionCronSlots,
  planSessionCronDisplay,
  retainLiveCronSlots,
  trailingSessionCronSegment,
} from "../lib/desk/session-cron-slot.ts";

function wake(jobId, anchorEntryId, id = `wake-${jobId}`) {
  return {
    role: "custom",
    customType: "session-cron-wake",
    id,
    content: "wake",
    details: {
      jobId,
      anchorEntryId,
      displayText: `定时 · ${jobId}`,
    },
  };
}

describe("session cron slot", () => {
  it("keeps one line of the previous conclusion", () => {
    expect(oneLineConclusion("  指纹\n还是 astra  ")).toBe("指纹 还是 astra");
    expect(oneLineConclusion("x".repeat(180)).endsWith("…")).toBe(true);
    expect(oneLineConclusion("x".repeat(180)).length).toBe(161);
  });

  it("anchors a new timer to the user turn that created it", () => {
    const entries = [
      { type: "message", id: "u7", message: { role: "user", content: "每小时查一次" } },
      { type: "message", id: "a7", message: { role: "assistant", content: "好" } },
    ];
    expect(anchorEntryIdFromBranch(entries)).toBe("u7");
  });

  it("rewinds only a trailing cron wake for the same job", () => {
    const wakeEntry = {
      type: "custom_message",
      customType: "session-cron-wake",
      id: "w1",
      parentId: "a7",
      details: { jobId: "job-1", anchorEntryId: "u7" },
    };
    const entries = [
      { type: "message", id: "u7", message: { role: "user", content: "设定时" } },
      { type: "message", id: "a7", message: { role: "assistant", content: "好" } },
      wakeEntry,
      { type: "message", id: "a8", message: { role: "assistant", content: "指纹未变" } },
    ];
    expect(trailingSessionCronSegment(entries, "job-1")).toMatchObject({
      anchorEntryId: "u7",
      text: "指纹未变",
      wake: wakeEntry,
    });
    const withLaterUser = [
      ...entries,
      { type: "message", id: "u9", message: { role: "user", content: "继续聊" } },
    ];
    expect(trailingSessionCronSegment(withLaterUser, "job-1")).toBeNull();
  });

  it("recovers this job's conclusion after another timer finished later", () => {
    const branch = (jobId, id, text) => ([
      {
        type: "custom_message",
        customType: "session-cron-wake",
        id,
        details: { jobId, anchorEntryId: "u7" },
      },
      { type: "message", id: `${id}-a`, message: { role: "assistant", content: text } },
    ]);
    const entries = [
      ...branch("A", "wA", "A conclusion\nwith detail"),
      ...branch("B", "wB", "B conclusion"),
    ];
    expect(trailingSessionCronSegment(entries, "A")).toMatchObject({
      anchorEntryId: "u7",
      text: "A conclusion\nwith detail",
    });
    expect(trailingSessionCronSegment(entries, "B")).toMatchObject({ text: "B conclusion" });
    const withLaterUser = [
      ...entries,
      { type: "message", id: "u9", message: { role: "user", content: "继续聊" } },
    ];
    expect(trailingSessionCronSegment(withLaterUser, "A")).toBeNull();

    const messages = [
      wake("A", "u7", "wA"),
      { role: "assistant", content: `${"A ".repeat(120)}done` },
      wake("B", "u7", "wB"),
      { role: "assistant", content: "B conclusion stays whole" },
    ];
    const kept = keepLatestSessionCronRange(messages);
    const serialized = JSON.stringify(kept);
    const summary = kept.find((message) => message.customType === "session-cron-conclusion");
    expect(serialized).toContain("B conclusion stays whole");
    expect(serialized).not.toContain(messages[1].content);
    expect(summary?.content.startsWith("A ")).toBe(true);
    expect(summary?.content.endsWith("…")).toBe(true);
    expect(summary?.role).toBe("custom");
    expect(kept.filter((message) => message.role === "assistant").at(-1)).toBe(messages[3]);
  });

  it("summarizes another job without orphaning its tool results", () => {
    const messages = [
      wake("A", "u7", "wA"),
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "probing A" },
          { type: "toolCall", id: "read-a", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "read-a",
        toolName: "read",
        content: [{ type: "text", text: "file body that must not leak" }],
      },
      { role: "assistant", stopReason: "stop", content: "A finished after tools" },
      wake("A", "u7", "wA2"),
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "still probing A" },
          { type: "toolCall", id: "read-a2", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "read-a2",
        toolName: "read",
        content: [{ type: "text", text: "second file body" }],
      },
      wake("B", "u7", "wB"),
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "read-b", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "read-b",
        toolName: "read",
        content: [{ type: "text", text: "B tool body" }],
      },
      { role: "assistant", stopReason: "stop", content: "B finished" },
    ];
    const kept = keepLatestSessionCronRange(messages);
    const serialized = JSON.stringify(kept);
    expect(serialized).not.toContain("file body that must not leak");
    expect(serialized).not.toContain("second file body");
    expect(serialized).not.toContain("probing A");
    expect(serialized).not.toContain("still probing A");
    expect(serialized).not.toContain("read-a");
    expect(serialized).toContain("B tool body");
    expect(serialized).toContain("read-b");
    expect(kept.find((message) => message.customType === "session-cron-conclusion")).toMatchObject({
      role: "custom",
      content: "A finished after tools",
      details: { jobId: "A", kind: "previous-conclusion" },
    });
    expect(kept.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual(["read-b"]);
  });

  it("ignores a toolUse prefix when recovering the previous finished conclusion", () => {
    const toolUse = (id, text) => ({
      type: "message",
      id,
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text },
          { type: "toolCall", id: `${id}-call`, name: "read", arguments: {} },
        ],
      },
    });
    const finished = (id, text) => ({
      type: "message",
      id,
      message: { role: "assistant", stopReason: "stop", content: text },
    });
    const wakeEntry = (id, jobId) => ({
      type: "custom_message",
      customType: "session-cron-wake",
      id,
      details: { jobId, anchorEntryId: "u7" },
    });
    const entries = [
      wakeEntry("wA", "A"),
      toolUse("probe-a", "probing A"),
      finished("done-a", "A finished after tools"),
      wakeEntry("wA2", "A"),
      toolUse("probe-a2", "still probing A"),
      wakeEntry("wB", "B"),
      finished("done-b", "B conclusion"),
    ];
    expect(trailingSessionCronSegment(entries, "A")).toMatchObject({
      text: "A finished after tools",
      anchorEntryId: "u7",
    });
    expect(trailingSessionCronSegment(entries, "A")?.text).not.toContain("probing");
  });

  it("drops older cron rounds from the model context and keeps the latest", () => {
    const messages = [
      { role: "user", content: "第7轮" },
      { role: "assistant", content: "已设定时" },
      wake("job-1", "u7", "w1"),
      { role: "assistant", content: "第一次" },
      wake("job-1", "u7", "w2"),
      { role: "assistant", content: "第二次" },
    ];
    expect(keepLatestSessionCronRange(messages)).toEqual([
      { role: "user", content: "第7轮" },
      { role: "assistant", content: "已设定时" },
      wake("job-1", "u7", "w2"),
      { role: "assistant", content: "第二次" },
    ]);
  });

  it("shows only the latest conclusion on the turn that created the timer", () => {
    const source = [
      { role: "user", id: "u7", content: "每小时查一次" },
      { role: "assistant", id: "a7", content: "已设定时" },
      { role: "user", id: "u8", content: "先说别的" },
      { role: "assistant", id: "a8", content: "好" },
      wake("job-1", "u7", "w1"),
      { role: "assistant", id: "c1", content: "第一次" },
      wake("job-1", "u7", "w2"),
      { role: "assistant", id: "c2", content: "第二次" },
    ];
    const plan = planSessionCronDisplay(source);
    expect([...plan.hide]).toEqual([4, 5, 6, 7]);
    expect(plan.slots).toEqual([
      expect.objectContaining({ jobId: "job-1", anchorEntryId: "u7", text: "第二次" }),
    ]);

    const visible = [
      { id: "0", entryId: "u7", role: "user", content: "每小时查一次", sourceIndex: 0 },
      { id: "1", entryId: "a7", role: "assistant", content: "已设定时", sourceIndex: 1 },
      { id: "2", entryId: "u8", role: "user", content: "先说别的", sourceIndex: 2 },
      { id: "3", entryId: "a8", role: "assistant", content: "好", sourceIndex: 3 },
    ];
    const blocks = [{ afterIndex: 3, type: "note" }];
    placeSessionCronSlots(visible, blocks, plan.slots, true);
    expect(visible.map((message) => message.content)).toEqual([
      "每小时查一次",
      "已设定时",
      "先说别的",
      "好",
      "第二次",
    ]);
    expect(visible[4]).toMatchObject({
      id: "cron-slot:job-1",
      cronSlotLabel: "定时 · job-1",
      sourceIndex: 6,
    });
    expect(blocks[0].afterIndex).toBe(3);
  });

  it("keeps the conclusion on the round that ran, not after later messages", () => {
    const slots = [{
      jobId: "job-1",
      wakeSourceIndex: 4,
      label: "定时 · job-1",
      text: "这一轮的结论",
    }];
    const visible = [
      { id: "0", role: "user", content: "设定时", sourceIndex: 0 },
      { id: "1", role: "assistant", content: "已设", sourceIndex: 1 },
      { id: "2", role: "user", content: "后来的话", sourceIndex: 8 },
      { id: "3", role: "assistant", content: "后来的回复", sourceIndex: 9 },
    ];
    placeSessionCronSlots(visible, [], slots, true, 0);
    expect(visible.map((message) => message.content)).toEqual([
      "设定时",
      "已设",
      "这一轮的结论",
      "后来的话",
      "后来的回复",
    ]);

    const tailOnly = [
      { id: "2", role: "user", content: "后来的话", sourceIndex: 8 },
      { id: "3", role: "assistant", content: "后来的回复", sourceIndex: 9 },
    ];
    placeSessionCronSlots(tailOnly, [], slots, true, 2);
    expect(tailOnly.map((message) => message.content)).toEqual([
      "后来的话",
      "后来的回复",
    ]);
  });

  it("drops the timer slot after the job is gone", () => {
    const slots = [
      { jobId: "studio_job_5", text: "旧结论" },
      { jobId: "studio_job_6", text: "还在跑" },
    ];
    expect(retainLiveCronSlots(slots, new Set(["studio_job_6"]))).toEqual([
      { jobId: "studio_job_6", text: "还在跑" },
    ]);
    expect(retainLiveCronSlots(slots, new Set())).toEqual([]);
    expect(retainLiveCronSlots(slots, null)).toEqual(slots);
  });

  it("keeps the last finished conclusion while the next check is still running", () => {
    const source = [
      wake("job-1", "u7", "w1"),
      { role: "assistant", id: "c1", stopReason: "stop", content: "第一次结论" },
      wake("job-1", "u7", "w2"),
      { role: "assistant", id: "c2", stopReason: "toolUse", content: "还在打探针" },
    ];
    const plan = planSessionCronDisplay(source);
    expect([...plan.hide]).toEqual([0, 1, 2, 3]);
    expect(plan.slots).toEqual([
      expect.objectContaining({ text: "第一次结论" }),
    ]);
  });

  it("keeps the previous conclusion when a new wake has no assistant yet", () => {
    const source = [
      { role: "user", id: "u1", content: "create timer" },
      wake("A", "u1", "w1"),
      { role: "assistant", id: "c1", stopReason: "stop", content: "previous finished conclusion" },
      wake("A", "u1", "w2"),
    ];
    const plan = planSessionCronDisplay(source);
    expect(plan.slots).toEqual([
      expect.objectContaining({ text: "previous finished conclusion", wakeSourceIndex: 1 }),
    ]);
    expect(plan.hide.has(3)).toBe(true);
    const visible = [{ role: "user", id: "u1", sourceIndex: 0, content: "create timer" }];
    placeSessionCronSlots(visible, [], plan.slots, true);
    expect(visible.map((message) => message.content)).toEqual([
      "create timer",
      "previous finished conclusion",
    ]);
  });

  it("leaves a pending automation suggestion outside the cron fold", () => {
    const suggestion = {
      role: "toolResult",
      toolCallId: "stop-A",
      toolName: "automation",
      content: [{ type: "text", text: "pending approval" }],
      details: {
        action: "pending_update",
        suggestionId: "sug-1",
        jobData: { id: "A", label: "A", prompt: "check", enabled: false },
        automationSuggestion: { suggestionId: "sug-1", operation: "update" },
      },
    };
    const confirmed = {
      role: "toolResult",
      toolCallId: "stop-direct",
      toolName: "automation",
      details: { action: "updated", job: { id: "A", enabled: false } },
    };
    const source = [
      wake("A", "u1", "w1"),
      suggestion,
      { role: "assistant", stopReason: "stop", content: "requested stop" },
      wake("B", "u1", "w2"),
      confirmed,
      { role: "assistant", stopReason: "stop", content: "already off" },
    ];
    const plan = planSessionCronDisplay(source);
    expect(plan.hide.has(1)).toBe(false);
    expect(plan.hide.has(0)).toBe(true);
    expect(plan.hide.has(2)).toBe(true);
    expect(plan.hide.has(4)).toBe(true);
    expect(plan.slots.map((slot) => slot.text)).toEqual(["requested stop", "already off"]);
  });

  it("keeps the finished slot when the new wake is only a tool call", () => {
    const source = [
      wake("A", "u1", "w1"),
      { role: "assistant", stopReason: "stop", content: "previous finished conclusion" },
      wake("A", "u1", "w2"),
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "still probing" },
          { type: "toolCall", id: "read-1", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "partial file" }],
      },
    ];
    const plan = planSessionCronDisplay(source);
    expect(plan.slots).toEqual([
      expect.objectContaining({ text: "previous finished conclusion", wakeSourceIndex: 0 }),
    ]);
    expect(plan.hide.has(3)).toBe(true);
    expect(plan.hide.has(4)).toBe(true);
  });

  it("extracts a pending suggestion the same way the history route does", () => {
    const suggestion = {
      role: "toolResult",
      toolCallId: "stop-A",
      toolName: "automation",
      details: {
        action: "pending_update",
        suggestionId: "sug-route",
        operation: "update",
        jobData: { id: "A", label: "Watch", prompt: "check", enabled: false, actorAgentId: "agent-a" },
      },
    };
    const source = [
      wake("A", "u1", "w1"),
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "stop-A", name: "automation", arguments: { action: "update" } }],
      },
      suggestion,
      { role: "assistant", stopReason: "stop", content: "requested stop" },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "not a card" }],
      },
    ];
    const plan = planSessionCronDisplay(source);
    const blocks = [];
    for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
      if (plan.hide.has(sourceIndex)) continue;
      const message = source[sourceIndex];
      if (message.role !== "toolResult") continue;
      blocks.push(...extractBlocks(message.toolName, message.details, message));
    }
    expect(plan.hide.has(2)).toBe(false);
    expect(plan.hide.has(4)).toBe(true);
    expect(blocks).toEqual([
      expect.objectContaining({
        type: "suggestion_card",
        suggestionId: "sug-route",
        status: "pending",
        operation: "update",
      }),
    ]);
  });
});
