import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCoordinator } from "../core/session-coordinator.ts";
import { classifySessionPermission } from "../core/session-permission-mode.ts";
import { TaskRegistry } from "../lib/task-registry.ts";

const PARENT = "E:/audit/parent.jsonl";

function setup(parentMode: string | null, entryPatch: Record<string, unknown> = {}) {
  const controllers = new Map<string, AbortController>();
  const registry = new TaskRegistry({
    getSessionIdForPath: (sessionPath: string) => (sessionPath === PARENT ? "sid-parent" : null),
  });
  registry.registerHandler("subagent", {
    abort: (taskId: string) => controllers.get(taskId)?.abort(),
  });
  const entry = {
    ...(parentMode ? { permissionMode: parentMode } : {}),
    ...entryPatch,
    agentId: "audit-agent",
    session: { isStreaming: true, messages: [{ role: "user", content: "current task" }], waitForIdle: vi.fn(async () => {}) },
  };
  const hub = { upsert: vi.fn() };
  const coord = new SessionCoordinator({
    getTaskRegistry: () => registry,
    getAgentById: () => ({ id: "audit-agent", agentDir: "E:/audit/agent" }),
    getActivityHub: () => hub,
    getSessionIdForPath: (sessionPath: string) => (sessionPath === PARENT ? "sid-parent" : null),
    setSubagentController: (id: string, ctrl: AbortController) => controllers.set(id, ctrl),
    removeSubagentController: (id: string) => controllers.delete(id),
  });
  (coord as any)._getSessionEntryByPath = () => entry;
  (coord as any)._sessionCwdFor = () => "E:/audit/workspace";
  let captured: any = null;
  let complete: (value?: any) => void = () => {};
  let fireReady: () => void = () => {};
  (coord as any).executeIsolated = vi.fn((_prompt: any, opts: any) => {
    captured = opts;
    fireReady = () => opts.onSessionReady("E:/audit/child.jsonl", {
      sessionId: "sid-child",
      sessionPath: "E:/audit/child.jsonl",
    });
    return new Promise((resolve) => {
      complete = (value?: any) => resolve(value === undefined ? { replyText: "done" } : value);
    });
  });
  (coord as any).abortSession = vi.fn(async (sessionPath: string) => {
    registry.abortByParentSession(sessionPath, "multitask_handoff");
    return true;
  });
  return {
    coord,
    registry,
    controllers,
    hub,
    parentSession: entry.session,
    getCaptured: () => captured,
    complete: (value?: any) => complete(value),
    fireReady: () => fireReady(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("multitask handoff permission and cancellation", () => {
  it.each(["read_only", "ask"])("inherits %s and a successful handoff does not abort the child", async (mode) => {
    const h = setup(mode);
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.fireReady();
    const result: any = await pending;
    const opts = h.getCaptured();
    expect(opts.permissionMode).toBe(mode);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    expect(h.controllers.get(result.taskId)?.signal).toBe(opts.signal);
    const task = h.registry.query(result.taskId);
    expect(task.status).toBe("running");
    expect(task.parentSessionPath).toBeNull();
    expect(task.parentSessionId).toBeNull();
    expect(task.parentSessionRef).toBeNull();
    expect(classifySessionPermission({
      mode: opts.permissionMode,
      toolName: "edit",
      context: { isSubagent: true },
    }).action).not.toBe("allow");
    expect(h.coord.abortSession).toHaveBeenCalledWith(PARENT, { reason: "multitask_handoff" });
    expect(h.hub.upsert.mock.calls[0][0].status).toBe("running");
    h.complete();
    await vi.waitFor(() => {
      expect(h.registry.query(result.taskId)?.status).toBe("completed");
      expect(h.controllers.has(result.taskId)).toBe(false);
      expect(h.hub.upsert.mock.calls.at(-1)[0].status).toBe("done");
    });
    expect(opts.signal.aborted).toBe(false);
  });

  it("uses planMode through getPermissionMode instead of escalating a missing permissionMode to operate", async () => {
    const h = setup(null, { planMode: true });
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.fireReady();
    await pending;
    expect(h.getCaptured().permissionMode).toBe("read_only");
  });

  it("passes the authoritative default when the session has no explicit permission fields", async () => {
    const h = setup(null);
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.fireReady();
    await pending;
    expect(h.getCaptured().permissionMode).toBe("auto");
    expect(h.getCaptured().permissionMode).not.toBe("operate");
  });

  it("fails closed when the parent permission mode cannot be resolved", async () => {
    const h = setup("read_only");
    (h.coord as any).getPermissionMode = () => {
      throw new Error("permission lookup unavailable");
    };
    const err = await h.coord.handoffStreamingTurnToSibling(PARENT).then((value) => value, (error) => error);
    expect(err.code).toBe("multitask_permission_unresolved");
    expect((h.coord as any).executeIsolated).not.toHaveBeenCalled();
    expect(h.registry.listByType("subagent")).toEqual([]);
    expect(h.controllers.size).toBe(0);
  });

  it("cancels a child aborted after ready and before the parent handoff abort", async () => {
    const h = setup("ask");
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT).then((value) => value, (err) => err);
    h.fireReady();
    [...h.controllers.values()][0].abort();
    const err = await pending;
    expect(err.code).toBe("multitask_aborted");
    expect(h.coord.abortSession).not.toHaveBeenCalled();
    const task = h.registry.listByType("subagent")[0];
    expect(["canceled", "aborted"]).toContain(task.status);
    expect(h.controllers.has(task.taskId)).toBe(false);
    expect(h.hub.upsert.mock.calls.at(-1)[0].status).toBe("aborted");
  });

  it("marks the activity card failed when the handed-off run fails", async () => {
    const h = setup("read_only");
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.fireReady();
    const result: any = await pending;
    h.complete({ error: "tool failed" });
    await vi.waitFor(() => {
      expect(h.registry.query(result.taskId)?.status).toBe("failed");
      expect(h.hub.upsert.mock.calls.at(-1)[0].status).toBe("failed");
    });
    expect(h.getCaptured().signal.aborted).toBe(false);
  });

  it("cancels a detached child if stopping the parent fails", async () => {
    const h = setup("ask");
    (h.coord as any).abortSession = vi.fn(async () => { throw new Error("parent stop failed"); });
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.fireReady();
    await expect(pending).rejects.toThrow("parent stop failed");
    expect(h.getCaptured().signal.aborted).toBe(true);
    await expect(h.getCaptured().beforePrompt()).resolves.toBeUndefined();
    expect(h.controllers.size).toBe(0);
    expect(h.hub.upsert.mock.calls.at(-1)[0].status).toBe("aborted");
    h.complete({ error: "aborted" });
  });

  it("does not release the child prompt until the parent stop has completed", async () => {
    const h = setup("ask");
    let stopParent!: () => void;
    (h.coord as any).abortSession = vi.fn(() => new Promise<boolean>(resolve => { stopParent = () => resolve(true); }));
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.fireReady();
    let released = false;
    const childGate = h.getCaptured().beforePrompt().then(() => { released = true; });
    await vi.waitFor(() => expect(stopParent).toBeTypeOf("function"));
    expect(released).toBe(false);
    stopParent();
    await pending;
    await childGate;
    expect(released).toBe(true);
    h.complete();
  });

  it("waits for actual SDK quiescence after the fast stop request returns", async () => {
    const h = setup('ask');
    let idle!: () => void;
    h.parentSession.waitForIdle.mockImplementation(() => new Promise<void>(resolve => { idle = resolve; }));
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.fireReady();
    let released = false;
    const gate = h.getCaptured().beforePrompt().then(() => { released = true; });
    await vi.waitFor(() => expect(idle).toBeTypeOf('function'));
    expect(h.coord.abortSession).toHaveBeenCalledOnce();
    expect(released).toBe(false);
    idle(); await pending; await gate;
    expect(released).toBe(true);
    h.complete();
  });

  it('cancels the prepared child when the parent finished while initializing it', async () => {
    const h = setup('ask');
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT);
    h.parentSession.isStreaming = false;
    h.fireReady();
    await expect(pending).rejects.toMatchObject({ code: 'multitask_parent_changed' });
    expect(h.getCaptured().signal.aborted).toBe(true);
    expect(h.coord.abortSession).not.toHaveBeenCalled();
    h.complete({ error: 'aborted' });
  });

  it('cancels the prepared child when the SDK does not become idle', async () => {
    vi.useFakeTimers();
    const h = setup('ask');
    h.parentSession.waitForIdle.mockImplementation(() => new Promise<void>(() => {}));
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT).catch(err => err);
    h.fireReady();
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await pending).code).toBe('multitask_parent_stop_timeout');
    expect(h.getCaptured().signal.aborted).toBe(true);
    h.complete({ error: 'aborted' });
  });

  it("fails before spawning if task registration is unavailable", async () => {
    const h = setup("ask");
    vi.spyOn(h.registry, "register").mockImplementation(() => { throw new Error("registry failed"); });
    await expect(h.coord.handoffStreamingTurnToSibling(PARENT)).rejects.toMatchObject({ code: "multitask_registration_failed" });
    expect((h.coord as any).executeIsolated).not.toHaveBeenCalled();
    expect(h.controllers.size).toBe(0);
  });

  it("cancels the child when the sibling is not ready in 20 seconds", async () => {
    vi.useFakeTimers();
    const h = setup("read_only");
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT).then((value) => value, (err) => err);
    await vi.advanceTimersByTimeAsync(20_001);
    const err = await pending;
    expect(err.code).toBe("multitask_ready_timeout");
    const opts = h.getCaptured();
    expect(opts.signal.aborted).toBe(true);
    expect(h.coord.abortSession).not.toHaveBeenCalled();
    const task = h.registry.listByType("subagent")[0];
    expect(task.status).toBe("canceled");
    expect(h.controllers.has(task.taskId)).toBe(false);
    h.fireReady();
    expect(h.coord.abortSession).not.toHaveBeenCalled();
    expect(h.hub.upsert).not.toHaveBeenCalled();
    h.complete();
  });

  it("cancels the child when the parent aborts before the sibling is ready", async () => {
    const h = setup("ask");
    const pending = h.coord.handoffStreamingTurnToSibling(PARENT).then((value) => value, (err) => err);
    const task = h.registry.listByType("subagent")[0];
    h.registry.abortByParentSession(PARENT, "user abort");
    const err = await pending;
    expect(err.code).toBe("multitask_aborted");
    expect(h.getCaptured().signal.aborted).toBe(true);
    expect(h.coord.abortSession).not.toHaveBeenCalled();
    expect(["aborted", "canceled"]).toContain(h.registry.query(task.taskId)?.status);
    expect(h.controllers.has(task.taskId)).toBe(false);
  });
});
