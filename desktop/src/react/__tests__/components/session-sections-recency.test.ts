import { describe, expect, it } from "vitest";
import {
  PROJECT_SESSION_RECENT_MS,
  splitProjectSessionsByRecency,
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

describe("splitProjectSessionsByRecency", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");

  it("keeps sessions from the last 3 days visible and hides older ones", () => {
    const recent = session({
      path: "/s/recent.jsonl",
      modified: new Date(now - PROJECT_SESSION_RECENT_MS + 60_000).toISOString(),
    });
    const old = session({
      path: "/s/old.jsonl",
      modified: new Date(now - PROJECT_SESSION_RECENT_MS - 60_000).toISOString(),
    });

    expect(splitProjectSessionsByRecency([recent, old], { now })).toEqual({
      visible: [recent],
      hidden: [old],
    });
  });

  it("keeps the current session visible even when it is older than 3 days", () => {
    const current = session({
      path: "/s/current.jsonl",
      sessionId: "sess_current",
      modified: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const old = session({
      path: "/s/old.jsonl",
      modified: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(splitProjectSessionsByRecency([current, old], {
      now,
      alwaysVisiblePaths: ["/s/current.jsonl"],
    })).toEqual({
      visible: [current],
      hidden: [old],
    });
  });

  it("keeps sessions with missing timestamps visible", () => {
    const unknown = session({ path: "/s/unknown.jsonl", modified: "" });
    const old = session({
      path: "/s/old.jsonl",
      modified: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(splitProjectSessionsByRecency([unknown, old], { now })).toEqual({
      visible: [unknown],
      hidden: [old],
    });
  });
});
