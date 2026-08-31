import { fetch as undiciFetch } from "undici";
import { fetchDispatcherForUrl } from "./outbound-proxy.ts";

let installed = false;
let originalFetch: typeof globalThis.fetch | null = null;

export function installProxiedGlobalFetch() {
  if (installed) return;
  if (typeof globalThis.fetch !== "function") return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : (input instanceof URL ? input.href : (input as Request)?.url);
    const { dispatcher } = fetchDispatcherForUrl(url);
    if (!dispatcher || !originalFetch) {
      return originalFetch!(input as any, init as any);
    }
    return undiciFetch(input as any, { ...(init as any), dispatcher });
  }) as typeof globalThis.fetch;
  installed = true;
}

export function restoreProxiedGlobalFetch() {
  if (!installed || !originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  installed = false;
}
