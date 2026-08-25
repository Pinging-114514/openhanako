import { describe, expect, it } from "vitest";
import {
  PROJECT_SESSION_PREVIEW_LIMIT,
  splitProjectSessionsByPreview,
} from "../../components/session-sections";
import type { Session } from "../../types";

function session(partial: Partial<Session> & Pick<Session, "path" | "modified">): Session {
  return {
    title: partial.title ?? partial.path,
    firstMessage: "",
    messageCount: 1,
    agentId: "hanako",
    agentName: "Hana",
    cwd: "/workspace",
    ...partial,
  };
}

describe("splitProjectSessionsByPreview", () => {
  it("does not fold when session count is at most the preview limit", () => {
    const items = [
      session({ path: "/s/1.jsonl", modified: "2026-08-19T12:00:00.000Z" }),
      session({ path: "/s/2.jsonl", modified: "2026-08-18T12:00:00.000Z" }),
      session({ path: "/s/3.jsonl", modified: "2026-08-17T12:00:00.000Z" }),
    ];

    expect(items.length).toBe(PROJECT_SESSION_PREVIEW_LIMIT);
    expect(splitProjectSessionsByPreview(items)).toEqual({
      visible: items,
      hidden: [],
    });
  });

  it("keeps the first N sessions visible and hides the rest when over the limit", () => {
    const items = [
      session({ path: "/s/1.jsonl", modified: "2026-08-19T12:00:00.000Z" }),
      session({ path: "/s/2.jsonl", modified: "2026-08-18T12:00:00.000Z" }),
      session({ path: "/s/3.jsonl", modified: "2026-08-17T12:00:00.000Z" }),
      session({ path: "/s/4.jsonl", modified: "2026-08-16T12:00:00.000Z" }),
      session({ path: "/s/5.jsonl", modified: "2026-08-15T12:00:00.000Z" }),
    ];

    expect(splitProjectSessionsByPreview(items)).toEqual({
      visible: items.slice(0, 3),
      hidden: items.slice(3),
    });
  });

  it("pins the current session into the preview window without expanding the fold", () => {
    const items = [
      session({ path: "/s/1.jsonl", modified: "2026-08-19T12:00:00.000Z" }),
      session({ path: "/s/2.jsonl", modified: "2026-08-18T12:00:00.000Z" }),
      session({ path: "/s/3.jsonl", modified: "2026-08-17T12:00:00.000Z" }),
      session({
        path: "/s/current.jsonl",
        sessionId: "sess_current",
        modified: "2026-08-10T12:00:00.000Z",
      }),
      session({ path: "/s/5.jsonl", modified: "2026-08-09T12:00:00.000Z" }),
    ];

    expect(splitProjectSessionsByPreview(items, {
      alwaysVisiblePaths: ["/s/current.jsonl"],
    })).toEqual({
      visible: [items[0], items[1], items[3]],
      hidden: [items[2], items[4]],
    });
  });
});
