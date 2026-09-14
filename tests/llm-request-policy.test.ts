import { describe, expect, it } from "vitest";
import { buildProviderCompatOptions } from "../core/llm-request-policy.ts";

describe("buildProviderCompatOptions", () => {
  it("keeps utility calls thinking-off by default", () => {
    expect(buildProviderCompatOptions({ mode: "utility" })).toMatchObject({
      mode: "utility",
      reasoningLevel: "off",
    });
  });

  it("lets an explicit reviewer thinking level through", () => {
    expect(buildProviderCompatOptions({
      mode: "utility",
      reasoningLevel: "xhigh",
    })).toMatchObject({
      mode: "utility",
      reasoningLevel: "xhigh",
    });
  });
});
