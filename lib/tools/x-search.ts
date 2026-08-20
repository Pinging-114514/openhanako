import { Type } from "../pi-sdk/index.ts";
import {
  callXaiOauthNativeSearch,
  formatXaiSearchResult,
} from "./xai-oauth-search.ts";

export function createXSearchTool({ xaiOauthSearchResolver }: Record<string, any> = {}) {
  return {
    name: "x_search",
    label: "X Search",
    description: "Search X/Twitter posts, users, and threads through xAI Grok OAuth. Image understanding is on by default: Grok will read images in posts.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search on X" }),
      allowed_x_handles: Type.Optional(Type.Array(Type.String(), {
        description: "Optional, only consider these handles, max 20, without @",
      })),
      from_date: Type.Optional(Type.String({ description: "Optional start date, YYYY-MM-DD" })),
      to_date: Type.Optional(Type.String({ description: "Optional end date, YYYY-MM-DD" })),
      understand_images: Type.Optional(Type.Boolean({
        description: "Read images found in posts. Default true.",
      })),
    }),
    execute: async (_toolCallId, params) => {
      const runtime = typeof xaiOauthSearchResolver === "function"
        ? (xaiOauthSearchResolver() || {})
        : {};
      const query = String(params?.query || "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "query 不能为空" }], details: {} };
      }
      const toolOptions: Record<string, any> = {
        enable_image_understanding: params?.understand_images !== false,
      };
      const handles = Array.isArray(params?.allowed_x_handles)
        ? params.allowed_x_handles.map((item) => String(item || "").replace(/^@/, "").trim()).filter(Boolean).slice(0, 20)
        : [];
      if (handles.length) toolOptions.allowed_x_handles = handles;
      const fromDate = String(params?.from_date || "").trim();
      const toDate = String(params?.to_date || "").trim();
      if (fromDate) toolOptions.from_date = fromDate;
      if (toDate) toolOptions.to_date = toDate;

      const result = await callXaiOauthNativeSearch({
        toolType: "x_search",
        prompt: query,
        toolOptions,
        accessToken: runtime.accessToken,
        modelId: runtime.modelId,
      });
      return {
        content: [{ type: "text", text: formatXaiSearchResult(result, "x_search") }],
        details: {
          tool: "x_search",
          ok: result.ok,
          citations: result.citations || [],
          status: result.status || 0,
        },
      };
    },
  };
}
