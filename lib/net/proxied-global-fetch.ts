import { fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";
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

let webSocketInstalled = false;
let originalWebSocket: typeof globalThis.WebSocket | null = null;

function webSocketUrlString(url: unknown): string {
  if (url instanceof URL) return url.href;
  return String(url ?? "");
}

function normalizeWebSocketOptions(protocolsOrOptions: unknown): Record<string, unknown> {
  if (Array.isArray(protocolsOrOptions) || typeof protocolsOrOptions === "string") {
    return { protocols: protocolsOrOptions };
  }
  if (protocolsOrOptions && typeof protocolsOrOptions === "object") {
    return { ...(protocolsOrOptions as Record<string, unknown>) };
  }
  return {};
}

/**
 * Route the global WebSocket through the same proxy decision as fetch.
 *
 * Node's built-in WebSocket is the internal undici copy and reads neither the
 * npm undici global dispatcher nor HTTPS_PROXY, so with a ladder proxy it dials
 * the origin directly and fails. pi-ai's Codex Responses transport builds on
 * `globalThis.WebSocket` (WebSocket first, SSE fallback); without this hook every
 * Codex session pays a connect timeout and then silently downgrades to SSE.
 *
 * When a proxy applies to the target, the socket is built with npm undici's
 * WebSocket plus the per-URL proxy dispatcher (same copy as the fetch path, so
 * the dispatcher contract is fixed). Direct targets keep the built-in class.
 * undici's WebSocket accepts `{ protocols, headers, dispatcher }` as its second
 * argument, a superset of the WHATWG protocols parameter that pi passes headers in.
 */
export function installProxiedGlobalWebSocket() {
  if (webSocketInstalled) return;
  const Original = (globalThis as any).WebSocket;
  if (typeof Original !== "function") return;
  originalWebSocket = Original;

  function ProxiedWebSocket(this: unknown, url: unknown, protocolsOrOptions?: unknown) {
    const href = webSocketUrlString(url);
    const { dispatcher } = fetchDispatcherForUrl(href);
    if (!dispatcher) {
      return new (Original as any)(url, protocolsOrOptions);
    }
    return new (UndiciWebSocket as any)(url, { ...normalizeWebSocketOptions(protocolsOrOptions), dispatcher });
  }
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(ProxiedWebSocket, key, { value: (Original as any)[key], enumerable: true });
  }
  ProxiedWebSocket.prototype = Original.prototype;

  (globalThis as any).WebSocket = ProxiedWebSocket;
  webSocketInstalled = true;
}

export function restoreProxiedGlobalWebSocket() {
  if (!webSocketInstalled || !originalWebSocket) return;
  (globalThis as any).WebSocket = originalWebSocket;
  originalWebSocket = null;
  webSocketInstalled = false;
}
