import { describe, expect, it } from "vitest";
import { mergeNotificationPreferences, normalizeNotificationPreferences } from "../shared/notification-preferences.ts";

describe("notification preferences", () => {
  it("defaults the completion chime off", () => {
    expect(normalizeNotificationPreferences({})).toMatchObject({
      chatCompletion: "never",
      chatCompletionSound: false,
    });
  });

  it("keeps an explicit completion chime flag", () => {
    expect(normalizeNotificationPreferences({ chatCompletionSound: true }).chatCompletionSound).toBe(true);
  });

  it("merges the completion chime without dropping other modes", () => {
    const merged = mergeNotificationPreferences(
      { chatCompletion: "when_unfocused", chatCompletionSound: false },
      { chatCompletionSound: true },
    );
    expect(merged).toMatchObject({
      chatCompletion: "when_unfocused",
      chatCompletionSound: true,
    });
  });
});
