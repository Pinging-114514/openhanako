import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionLocatorKey } from "../core/session-manifest/path-normalizer.ts";
import { Scheduler } from "../hub/scheduler.ts";
import { planSessionCronDisplay } from "../lib/desk/session-cron-slot.ts";
import { createAutomationTool } from "../lib/tools/automation-tool.ts";
import { extractBlocks } from "../server/block-extractors.ts";
import {
  beginSessionCronCheck,
  isSessionCronCheck,
  resetSessionCronCheck,
  settleSessionCronRotation,
} from "../desktop/src/react/stores/session-cron-check.ts";

const SESSION = "cron-lifecycle-session";

function applyCronEvent(sessionPath, event, settled) {
  if (event.type === "session_cron_checking") {
    beginSessionCronCheck(sessionPath, event.label || "", event.wakeId || event.jobId);
    return;
  }
  if (event.type !== "session_cron_rotated") return;
  const effect = settleSessionCronRotation(sessionPath, event.wakeId || event.jobId, {
    preserveClientState: event.preserveClientState === true,
  });
  if (effect.shouldSettle) settled.push(event.jobId);
}

function blocksOutsideCronFold(messages) {
  const plan = planSessionCronDisplay(messages);
  const blocks = [];
  for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
    if (plan.hide.has(sourceIndex)) continue;
    const message = messages[sourceIndex];
    if (message?.role !== "toolResult") continue;
    blocks.push(...extractBlocks(message.toolName, message.details, message));
  }
  return { plan, blocks };
}

function sourceJob(root, id) {
  const sourceSessionPath = path.join(root, "sessions", "source.jsonl");
  fs.mkdirSync(path.dirname(sourceSessionPath), { recursive: true });
  fs.writeFileSync(sourceSessionPath, "", "utf-8");
  const executionContext = {
    kind: "session_workspace",
    cwd: "/workspace/stale",
    workspaceFolders: [],
    authorizedFolders: [],
    sourceSessionId: "sess-source",
    sourceBridgeSessionKey: null,
    sourceSessionPath,
    createdByAgentId: "agent-a",
    notificationContext: null,
  };
  return {
    sourceSessionPath,
    job: {
      studioId: "studio-a",
      id,
      label: id,
      prompt: "check the fingerprint",
      actorAgentId: "agent-a",
      executionContext,
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "check the fingerprint",
        executionContext,
      },
    },
  };
}

function engineFor(root, sourceSessionPath, hooks) {
  return {
    agentsDir: path.join(root, "agents"),
    agents: new Map(),
    getAgent: vi.fn(() => ({ id: "agent-a", agentName: "Hana" })),
    isAgentDeleted: vi.fn(() => false),
    getSessionManifest: vi.fn(() => ({
      sessionId: "sess-source",
      ownerAgentId: "agent-a",
      lifecycle: "active",
      health: "ok",
      currentLocator: {
        type: "jsonl",
        path: sourceSessionPath,
        key: sessionLocatorKey(sourceSessionPath),
      },
    })),
    getSessionIdForPath: vi.fn(() => "sess-source"),
    getSessionFolderScope: vi.fn(() => ({
      cwd: "/workspace/live",
      workspaceFolders: ["/workspace/live"],
      authorizedFolders: [],
    })),
    prepareSessionCronWake: hooks.prepareSessionCronWake,
    deliverCustomMessage: hooks.deliverCustomMessage,
    emitSessionEventForPath: hooks.emitSessionEventForPath,
  };
}

describe("session cron wake lifecycle", () => {
  afterEach(() => {
    resetSessionCronCheck(SESSION);
  });

  it("counts anonymous checks so one rotated event cannot clear the other", () => {
    beginSessionCronCheck(SESSION, "A");
    beginSessionCronCheck(SESSION, "B");
    expect(settleSessionCronRotation(SESSION).shouldSettle).toBe(false);
    expect(isSessionCronCheck(SESSION)).toBe(true);
    expect(settleSessionCronRotation(SESSION).shouldSettle).toBe(true);
    expect(isSessionCronCheck(SESSION)).toBe(false);
  });

  it("emits checking only once the idle turn starts, and clears it after an error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cron-life-"));
    try {
      const { sourceSessionPath, job } = sourceJob(root, "job-a");
      const events = [];
      const deliverCustomMessage = vi.fn(async (_sessionPath, message, options) => {
        expect(message.content).toContain("上次结论：指纹未变");
        options.beforeInputSideEffects();
        throw new Error("model exploded");
      });
      const scheduler = new Scheduler({
        hub: {
          engine: engineFor(root, sourceSessionPath, {
            prepareSessionCronWake: async () => ({ previousConclusion: "指纹未变", anchorEntryId: "u7" }),
            deliverCustomMessage,
            emitSessionEventForPath: (event) => events.push(event),
          }),
          eventBus: { emit: vi.fn() },
        },
      });

      await expect(scheduler._executeCronJob(job)).rejects.toThrow("model exploded");
      expect(events.map((event) => event.type)).toEqual(["session_cron_checking", "session_cron_rotated"]);
      expect(events[0].jobId).toBe("job-a");
      expect(events[1].wakeId).toBe(events[0].wakeId);
      expect(events[1].preserveClientState).toBeUndefined();

      const settled = [];
      for (const event of events) applyCronEvent(SESSION, event, settled);
      expect(settled).toEqual(["job-a"]);
      expect(isSessionCronCheck(SESSION)).toBe(false);
      await expect(scheduler._executeCronJob(job)).rejects.toThrow("model exploded");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not emit checking or rotated when the session is busy and the wake is only queued", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cron-life-"));
    try {
      const { sourceSessionPath, job } = sourceJob(root, "job-a");
      const events = [];
      const deliverCustomMessage = vi.fn(async () => ({ ok: true, mode: "followUp" }));
      const scheduler = new Scheduler({
        hub: {
          engine: engineFor(root, sourceSessionPath, {
            deliverCustomMessage,
            emitSessionEventForPath: (event) => events.push(event),
          }),
          eventBus: { emit: vi.fn() },
        },
      });
      await expect(scheduler._executeCronJob(job)).resolves.toMatchObject({ queued: true });
      expect(events).toEqual([]);
      expect(deliverCustomMessage.mock.calls[0][2].triggerTurn).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases a raced follow-up check without settling the user stream", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cron-life-"));
    try {
      const { sourceSessionPath, job } = sourceJob(root, "job-a");
      const events = [];
      const deliverCustomMessage = vi.fn(async (_sessionPath, _message, options) => {
        options.beforeInputSideEffects();
        return { ok: true, mode: "followUp" };
      });
      const scheduler = new Scheduler({
        hub: {
          engine: engineFor(root, sourceSessionPath, {
            deliverCustomMessage,
            emitSessionEventForPath: (event) => events.push(event),
          }),
          eventBus: { emit: vi.fn() },
        },
      });
      await scheduler._executeCronJob(job);
      expect(events.map((event) => event.type)).toEqual(["session_cron_checking", "session_cron_rotated"]);
      expect(events[1].preserveClientState).toBe(true);
      const settled = [];
      for (const event of events) applyCronEvent(SESSION, event, settled);
      expect(settled).toEqual([]);
      expect(isSessionCronCheck(SESSION)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the other job checking marker when one overlapping wake finishes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cron-life-"));
    try {
      const { sourceSessionPath, job: jobA } = sourceJob(root, "job-a");
      const { job: jobB } = sourceJob(root, "job-b");
      const events = [];
      let releaseA;
      const deliverCustomMessage = vi.fn((_sessionPath, message, options) => {
        options.beforeInputSideEffects();
        if (message.details.jobId === "job-a") {
          return new Promise((resolve) => {
            releaseA = () => resolve({ ok: true, mode: "triggerTurn" });
          });
        }
        return Promise.resolve({ ok: true, mode: "triggerTurn" });
      });
      const scheduler = new Scheduler({
        hub: {
          engine: engineFor(root, sourceSessionPath, {
            deliverCustomMessage,
            emitSessionEventForPath: (event) => {
              events.push(event);
              applyCronEvent(SESSION, event, []);
            },
          }),
          eventBus: { emit: vi.fn() },
        },
      });
      const runningA = scheduler._executeCronJob(jobA);
      await vi.waitFor(() => expect(events.some((event) => event.type === "session_cron_checking" && event.jobId === "job-a")).toBe(true));
      await scheduler._executeCronJob(jobB);
      expect(isSessionCronCheck(SESSION)).toBe(true);
      expect(events.filter((event) => event.type === "session_cron_rotated").map((event) => event.jobId)).toEqual(["job-b"]);
      releaseA();
      await runningA;
      expect(isSessionCronCheck(SESSION)).toBe(false);
      expect(events.filter((event) => event.type === "session_cron_rotated").map((event) => event.jobId)).toEqual(["job-b", "job-a"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows an ask-mode self-stop suggestion and still direct-disables in operate", async () => {
    const ownJob = {
      id: "job-a",
      type: "every",
      schedule: 600000,
      prompt: "check",
      label: "Watch",
      enabled: true,
      actorAgentId: "agent-a",
      executionContext: { sourceSessionId: "sess", createdByAgentId: "agent-a" },
      createdBy: { sourceSessionId: "sess" },
    };
    const store = {
      studioId: "studio-a",
      updateJob: vi.fn((id, fields) => ({ ...ownJob, ...fields, id })),
      getJob: vi.fn(() => ownJob),
      listJobs: vi.fn(() => [ownJob]),
    };
    const suggestionStore = {
      create: vi.fn((entry) => ({ ...entry, suggestionId: "sug-stop", shortCode: "4451" })),
    };
    const askTool = createAutomationTool(store, {
      getAutoApprove: () => false,
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
    });
    const pending = await askTool.execute(
      "stop-ask",
      { action: "update", id: "job-a", enabled: false },
      undefined,
      undefined,
      { sessionId: "sess" },
    );
    expect(store.updateJob).not.toHaveBeenCalled();
    expect(pending.details.action).toBe("pending_update");
    const wake = {
      role: "custom",
      customType: "session-cron-wake",
      id: "w1",
      details: { jobId: "job-a", displayText: "定时 · Watch" },
    };
    const visible = blocksOutsideCronFold([
      wake,
      { role: "toolResult", toolName: "automation", toolCallId: "stop-ask", details: pending.details },
      { role: "assistant", stopReason: "stop", content: "该关了" },
    ]);
    expect(visible.plan.hide.has(1)).toBe(false);
    expect(visible.blocks).toEqual([
      expect.objectContaining({
        type: "suggestion_card",
        kind: "automation_draft",
        suggestionId: "sug-stop",
        status: "pending",
        operation: "update",
      }),
    ]);

    const operateTool = createAutomationTool(store, {
      getAutoApprove: () => true,
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
    });
    const direct = await operateTool.execute(
      "stop-operate",
      { action: "update", id: "job-a", enabled: false },
      undefined,
      undefined,
      { sessionId: "sess" },
    );
    expect(direct.details.action).toBe("updated");
    expect(store.updateJob).toHaveBeenCalledWith("job-a", expect.objectContaining({ enabled: false }));
    const hidden = blocksOutsideCronFold([
      wake,
      { role: "toolResult", toolName: "automation", toolCallId: "stop-operate", details: direct.details },
      { role: "assistant", stopReason: "stop", content: "already off" },
    ]);
    expect(hidden.plan.hide.has(1)).toBe(true);
    expect(hidden.blocks).toEqual([]);
  });
});
