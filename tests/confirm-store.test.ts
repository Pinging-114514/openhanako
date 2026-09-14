import { describe, expect, it } from "vitest";
import { ConfirmStore } from "../lib/confirm-store.ts";

describe("ConfirmStore", () => {
  it("exposes pending confirmation metadata without resolving it", () => {
    const store = new ConfirmStore();
    const { confirmId } = (store as any).create(
      "tool_action_approval",
      { toolName: "write" },
      "/sessions/a.jsonl",
      60_000,
    );

    expect(store.get(confirmId)).toEqual({
      sessionId: null,
      sessionPath: "/sessions/a.jsonl",
      kind: "tool_action_approval",
      payload: { toolName: "write" },
    });
    expect(store.size).toBe(1);

    (store as any).resolve(confirmId, "rejected");
    expect(store.get(confirmId)).toBeNull();
  });

  it("aborts pending confirmations by stable session id after the session path moves", async () => {
    const originalPath = "/sessions/original.jsonl";
    const movedPath = "/sessions/archived/renamed.jsonl";
    const sessionId = "sess_confirm_stable";
    const store = new ConfirmStore({
      getSessionIdForPath: (sessionPath: string) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    });
    const { confirmId, promise } = (store as any).create(
      "tool_action_approval",
      { toolName: "write" },
      originalPath,
      60_000,
    );

    expect(store.get(confirmId)).toMatchObject({
      sessionPath: originalPath,
      sessionId,
    });

    store.abortBySession(movedPath);

    await expect(promise).resolves.toEqual({ action: "aborted" });
    expect(store.get(confirmId)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("reports pending confirmations by kind and session", () => {
    const store = new ConfirmStore();
    (store as any).create("user_choice", { question: "Q" }, "/sessions/a.jsonl", 60_000);
    (store as any).create("settings", { key: "theme" }, "/sessions/b.jsonl", 60_000);

    expect(store.hasPending("user_choice", "/sessions/a.jsonl")).toBe(true);
    expect(store.hasPending("user_choice", "/sessions/b.jsonl")).toBe(false);
    expect(store.hasPending("settings", "/sessions/a.jsonl")).toBe(false);
    expect(store.hasPending("settings", "/sessions/b.jsonl")).toBe(true);
  });
});
