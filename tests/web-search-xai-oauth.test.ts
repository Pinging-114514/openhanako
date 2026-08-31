import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool, resetWebSearchRateLimiterForTests } from "../lib/tools/web-search.ts";
import { XAI_OAUTH_SEARCH_PROVIDER } from "../shared/search-providers.ts";

describe("web_search xAI OAuth backend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetWebSearchRateLimiterForTests();
  });

  it("uses Grok OAuth first in auto mode when the provider toggle is on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: "Grok answer",
      citations: ["https://example.com/doc"],
    }), { status: 200 })));

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "auto", api_keys: {} }),
      xaiOauthSearchResolver: () => ({
        enabled: true,
        accessToken: "grok-access",
        modelId: "grok-4.6",
      }),
    });
    const result = await tool.execute("call-1", { query: "what is hana", maxResults: 3 });
    expect(result.details.provider).toBe(XAI_OAUTH_SEARCH_PROVIDER);
    expect(result.details.results[0]).toMatchObject({
      url: "https://example.com/doc",
      content: "Grok answer",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1].body);
    expect(body.model).toBe("grok-4-1-fast-non-reasoning");
    expect(body.tools.map((item) => item.type)).toEqual(["web_search"]);
    expect(body.tools[0].enable_image_understanding).toBe(false);
    expect(String(body.instructions || "")).toMatch(/search result extractor/i);
  });

  it("does not call Grok when the provider toggle is off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: XAI_OAUTH_SEARCH_PROVIDER }),
      xaiOauthSearchResolver: () => ({ enabled: false, accessToken: "grok-access" }),
    });
    const result = await tool.execute("call-1", { query: "what is hana" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(result.content?.[0]?.text || "")).toMatch(/search|xAI|OAuth/i);
  });
});
