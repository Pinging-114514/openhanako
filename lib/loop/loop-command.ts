/**
 * loop-command.ts — /loop 参数解析
 *
 * 启动：/loop [--turns N|-n N] <任务>
 * 管理：/loop stop | pause | resume | status | turns <N>
 */
import { clampLoopTurns } from "./loop-store.ts";

const LOOP_SUBCOMMANDS = new Set(["stop", "pause", "resume", "status", "turns"]);
const TURNS_FLAG_RE = /(?:^|\s)(?:--turns|-n)(?:\s+|=)(\d+)(?=\s|$)/g;

export function parseLoopCommand(raw: unknown) {
  const args = String(raw || "").trim();
  if (!args) return { kind: "empty" as const };

  const firstToken = args.split(/\s+/, 1)[0]?.toLowerCase() || "";
  if (firstToken === "turns") {
    const rest = args.slice(firstToken.length).trim();
    const token = rest.split(/\s+/, 1)[0] || "";
    try {
      return { kind: "turns" as const, maxTurns: clampLoopTurns(token) };
    } catch (err: any) {
      return { kind: "error" as const, message: err?.message || "用法：/loop turns <轮数>" };
    }
  }
  if (LOOP_SUBCOMMANDS.has(firstToken)) {
    return { kind: firstToken as "stop" | "pause" | "resume" | "status" };
  }

  let maxTurns: number | null = null;
  let flagError: string | null = null;
  const prompt = args.replace(TURNS_FLAG_RE, (_, digits) => {
    try {
      maxTurns = clampLoopTurns(digits);
    } catch (err: any) {
      flagError = err?.message || "轮数无效";
    }
    return " ";
  }).replace(/\s+/g, " ").trim();

  if (flagError) return { kind: "error" as const, message: flagError };
  if (!prompt) {
    return { kind: "error" as const, message: "用法：/loop [--turns N] <任务> | /loop stop | pause | resume | status | turns <N>" };
  }
  return { kind: "start" as const, prompt, maxTurns };
}
