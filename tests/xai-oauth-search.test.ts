import { describe, expect, it } from "vitest";
import {
  collectXaiSearchCitations,
  extractXaiSearchText,
  resultsFromXaiSearch,
} from "../lib/tools/xai-oauth-search.ts";

describe("xAI OAuth search mapping", () => {
  it("extracts output_text and citation URLs", () => {
    const data = {
      output_text: "Grok found two pages.",
      citations: ["https://example.com/a", { url: "https://example.com/b" }],
      output: [
        {
          content: [
            {
              annotations: [{ url: "https://example.com/a" }, { uri: "https://example.com/c" }],
            },
          ],
        },
      ],
    };
    expect(extractXaiSearchText(data)).toBe("Grok found two pages.");
    expect(collectXaiSearchCitations(data)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("turns citations into web_search results and keeps the answer on the first hit", () => {
    const results = resultsFromXaiSearch({
      text: "Summary of the web.",
      citations: ["https://www.example.com/post", "https://news.example.org/item"],
    }, 5);
    expect(results).toEqual([
      { title: "example.com", url: "https://www.example.com/post", snippet: "Summary of the web." },
      { title: "news.example.org", url: "https://news.example.org/item", snippet: "" },
    ]);
  });

  it("falls back to a single text result when there are no citations", () => {
    expect(resultsFromXaiSearch({ text: "Just an answer.", citations: [] })).toEqual([
      { title: "Grok search", url: "", snippet: "Just an answer." },
    ]);
  });

  it("marks X/Twitter citations", () => {
    const results = resultsFromXaiSearch({
      text: "Posts and pages.",
      citations: ["https://x.com/foo/status/1", "https://example.com/a"],
    }, 5);
    expect(results[0].title).toBe("X · x.com");
    expect(results[1].title).toBe("example.com");
  });
});
