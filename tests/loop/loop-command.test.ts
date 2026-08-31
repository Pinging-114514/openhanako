import { describe, expect, it } from "vitest";
import { parseLoopCommand } from "../../lib/loop/loop-command.ts";
import { LOOP_TURNS_MAX, clampLoopTurns } from "../../lib/loop/loop-store.ts";

describe("parseLoopCommand", () => {
  it("treats empty input as empty", () => {
    expect(parseLoopCommand("")).toEqual({ kind: "empty" });
    expect(parseLoopCommand("   ")).toEqual({ kind: "empty" });
  });

  it("parses management subcommands", () => {
    expect(parseLoopCommand("stop")).toEqual({ kind: "stop" });
    expect(parseLoopCommand("pause")).toEqual({ kind: "pause" });
    expect(parseLoopCommand("resume")).toEqual({ kind: "resume" });
    expect(parseLoopCommand("status")).toEqual({ kind: "status" });
  });

  it("parses turns subcommand and clamps the budget", () => {
    expect(parseLoopCommand("turns 25")).toEqual({ kind: "turns", maxTurns: 25 });
    expect(parseLoopCommand("turns 100")).toEqual({ kind: "turns", maxTurns: 100 });
    expect(parseLoopCommand(`turns ${LOOP_TURNS_MAX + 80}`)).toEqual({ kind: "turns", maxTurns: LOOP_TURNS_MAX });
    expect(parseLoopCommand("turns")).toMatchObject({ kind: "error" });
  });

  it("parses a start prompt with optional --turns / -n", () => {
    expect(parseLoopCommand("watch the pipeline")).toEqual({
      kind: "start",
      prompt: "watch the pipeline",
      maxTurns: null,
    });
    expect(parseLoopCommand("--turns 100 复现论文")).toEqual({
      kind: "start",
      prompt: "复现论文",
      maxTurns: 100,
    });
    expect(parseLoopCommand("复现论文 -n 25")).toEqual({
      kind: "start",
      prompt: "复现论文",
      maxTurns: 25,
    });
  });

  it("rejects a turns flag without a task", () => {
    expect(parseLoopCommand("--turns 100")).toMatchObject({ kind: "error" });
  });
});

describe("clampLoopTurns", () => {
  it("rejects non-positive values and caps the upper bound", () => {
    expect(() => clampLoopTurns(0)).toThrow(/轮数/);
    expect(clampLoopTurns(1)).toBe(1);
    expect(clampLoopTurns(500)).toBe(500);
    expect(clampLoopTurns(9999)).toBe(500);
  });
});
