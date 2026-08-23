import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import lockfile from "proper-lockfile";
import { createAuthStorageWithRetry } from "../lib/auth/auth-storage-boot.ts";

function writeAuth(dir: string, data: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(data, null, 2), "utf-8");
}

describe("createAuthStorageWithRetry", () => {
  it("loads oauth credentials when the file is free", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-auth-boot-"));
    try {
      writeAuth(dir, {
        "xai-oauth": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
      });
      const storage = createAuthStorageWithRetry(path.join(dir, "auth.json"), { retries: 1, delayMs: 0 });
      expect(storage.get("xai-oauth")).toMatchObject({ type: "oauth", access: "a" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps memory empty while auth.json is locked, then recovers after unlock+reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-auth-boot-"));
    const authPath = path.join(dir, "auth.json");
    let release: (() => void) | undefined;
    try {
      writeAuth(dir, {
        "xai-oauth": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
      });
      const logs: string[] = [];
      release = lockfile.lockSync(authPath, { realpath: false, stale: 600_000 });
      const storage = createAuthStorageWithRetry(authPath, {
        log: (line) => logs.push(line),
        retries: 2,
        delayMs: 0,
      });
      expect(storage.get("xai-oauth")).toBeUndefined();
      expect(logs.some((line) => line.includes("auth.json"))).toBe(true);
      release();
      release = undefined;
      storage.reload();
      expect(storage.get("xai-oauth")).toMatchObject({ type: "oauth", access: "a" });
    } finally {
      try { release?.(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
