import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createAuthStorageWithRetry } from "../lib/auth/auth-storage-boot.ts";

function writeAuth(dir: string, data: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(data, null, 2), "utf-8");
}

describe("createAuthStorageWithRetry", () => {
  it("loads oauth credentials when the file is free", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-auth-boot-"));
    try {
      writeAuth(dir, {
        "xai-oauth": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
      });
      const storage = createAuthStorageWithRetry(path.join(dir, "auth.json"), { retries: 1, delayMs: 0 });
      await expect(storage.read("xai-oauth")).resolves.toMatchObject({ type: "oauth", access: "a" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates an empty store when auth.json does not exist yet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-auth-boot-"));
    try {
      const logs: string[] = [];
      const storage = createAuthStorageWithRetry(path.join(dir, "auth.json"), {
        log: (line) => logs.push(line),
        retries: 1,
        delayMs: 0,
      });
      await expect(storage.read("xai-oauth")).resolves.toBeUndefined();
      expect(logs).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a half-written auth.json and recovers once the file is complete", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-auth-boot-"));
    const authPath = path.join(dir, "auth.json");
    try {
      fs.writeFileSync(authPath, "{\"xai-oauth\": {\"type\": \"oauth\", \"access\": \"a\"", "utf-8");
      const logs: string[] = [];
      const storage = createAuthStorageWithRetry(authPath, {
        log: (line) => logs.push(line),
        retries: 2,
        delayMs: 0,
      });
      expect(logs.some((line) => line.includes("auth.json load failed"))).toBe(true);
      expect(logs.some((line) => line.includes("still unreadable"))).toBe(true);

      writeAuth(dir, {
        "xai-oauth": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
      });
      storage.reload();
      await expect(storage.read("xai-oauth")).resolves.toMatchObject({ type: "oauth", access: "a" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
