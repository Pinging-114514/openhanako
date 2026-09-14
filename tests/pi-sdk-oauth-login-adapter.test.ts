import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  AuthStorage,
  createModelRuntime,
  loginOAuthProvider,
  toAuthInteraction,
  type OAuthLoginCallbacks,
} from "../lib/pi-sdk/index.ts";

describe("Pi SDK OAuth login adapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-oauth-login-adapter-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("satisfies the real 0.85 selector contract before browser I/O starts", async () => {
    const authPath = path.join(tmpDir, "auth.json");
    const runtime = await createModelRuntime({
      credentials: AuthStorage.create(authPath),
      authPath,
      modelsJsonPath: path.join(tmpDir, "models.json"),
    });
    const sentinel = new Error("__hana_stop_before_io__");
    const onAuth = vi.fn();
    const onDeviceCode = vi.fn();
    const callbacks: OAuthLoginCallbacks = {
      onAuth,
      onDeviceCode,
      onPrompt: async () => "",
      onSelect: async (prompt) => {
        expect(prompt.options.map(option => option.id)).toContain("browser");
        throw sentinel;
      },
      signal: new AbortController().signal,
    };

    await expect(loginOAuthProvider(runtime, "openai-codex", callbacks))
      .rejects.toThrow("__hana_stop_before_io__");
    expect(onAuth).not.toHaveBeenCalled();
    expect(onDeviceCode).not.toHaveBeenCalled();
    expect(fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf-8") : "").not.toContain("access");
  });

  it("translates SDK auth events back into Hana's legacy login callbacks", async () => {
    const onAuth = vi.fn();
    const onDeviceCode = vi.fn();
    const onPrompt = vi.fn(async () => "typed-code");
    const onManualCodeInput = vi.fn(async () => "pasted-code");
    const onSelect = vi.fn(async () => "device");
    const signal = new AbortController().signal;
    const interaction = toAuthInteraction({
      onAuth,
      onDeviceCode,
      onPrompt,
      onManualCodeInput,
      onSelect,
      signal,
    } as OAuthLoginCallbacks);

    expect(interaction.signal).toBe(signal);

    interaction.notify({ type: "auth_url", url: "https://example.test/auth", instructions: "open it" });
    expect(onAuth).toHaveBeenCalledWith({ url: "https://example.test/auth", instructions: "open it" });

    interaction.notify({
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://example.test/device",
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });
    expect(onDeviceCode).toHaveBeenCalledWith({
      userCode: "ABCD-1234",
      verificationUri: "https://example.test/device",
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });

    await expect(interaction.prompt({ type: "manual_code", message: "Paste the code" })).resolves.toBe("pasted-code");
    await expect(interaction.prompt({ type: "text", message: "Enter something" })).resolves.toBe("typed-code");
    await expect(interaction.prompt({
      type: "select",
      message: "How do you want to sign in?",
      options: [{ id: "browser", label: "Browser" }, { id: "device", label: "Device code" }],
    })).resolves.toBe("device");
  });

  it("falls back to onAuth for device codes when the caller has no onDeviceCode", () => {
    const onAuth = vi.fn();
    const interaction = toAuthInteraction({
      onAuth,
      onPrompt: async () => "",
      signal: new AbortController().signal,
    } as unknown as OAuthLoginCallbacks);

    interaction.notify({ type: "device_code", userCode: "ZZZZ", verificationUri: "https://example.test/d" });
    expect(onAuth).toHaveBeenCalledWith({ url: "https://example.test/d", instructions: "ZZZZ" });
  });
});
