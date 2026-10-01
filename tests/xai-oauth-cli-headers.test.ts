import { describe, expect, it } from "vitest";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_VERSION,
  buildXaiOauthCliModelHeaders,
  buildXaiOauthCliProviderHeaders,
} from "../lib/providers/xai-oauth-cli-headers.ts";

describe("xai-oauth CLI proxy headers", () => {
  it("pins a client version above the 426 floor and identifies as hana", () => {
    expect(GROK_CLI_CLIENT_VERSION).toBe("1.0.13");
    expect(GROK_CLI_CLIENT_IDENTIFIER).toBe("hana");
    expect(buildXaiOauthCliProviderHeaders()).toEqual({
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "1.0.13",
      "x-grok-client-identifier": "hana",
    });
  });

  it("builds per-model override headers and strips provider prefixes", () => {
    expect(buildXaiOauthCliModelHeaders("grok-4.5")).toEqual({
      "x-grok-model-override": "grok-4.5",
    });
    expect(buildXaiOauthCliModelHeaders("xai-oauth/Grok-Build-Latest")).toEqual({
      "x-grok-model-override": "grok-build-latest",
    });
    expect(buildXaiOauthCliModelHeaders("")).toEqual({});
  });
});
