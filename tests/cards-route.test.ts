import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CARD_VIEW_TICKET_LIMIT, createCardsRoute } from "../server/routes/cards.ts";

function buildApp() {
  const app = new Hono();
  app.route("/api", createCardsRoute({}));
  return app;
}

function putCard(app: Hono, cardId: string, body: Record<string, unknown>) {
  return app.request(`/api/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cards route", () => {
  it("PUT registers code, then GET serves it as HTML", async () => {
    const app = buildApp();
    const code = '<button onclick="x()">开始</button>';
    const put = await putCard(app, "c_abc123", { code, title: "pomodoro", varsCss: "--accent: #537D96;" });
    expect(put.status).toBe(200);
    const registered = await put.json() as { ok?: boolean; ticket?: string };
    expect(registered.ok).toBe(true);
    expect(registered.ticket).toMatch(/^[A-Za-z0-9_-]+$/);

    const get = await app.request("/api/cards/c_abc123");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/html");
    const html = await get.text();
    expect(html).toContain(code);
    expect(html).toContain("--accent: #537D96;");
  });

  it("GET with a matching iframe ticket succeeds and a wrong ticket is rejected", async () => {
    const app = buildApp();
    const put = await putCard(app, "c_ticket", { code: "<div>ticketed</div>" });
    const registered = await put.json() as { ticket?: string };
    expect(registered.ticket).toBeTruthy();

    const ok = await app.request(`/api/cards/c_ticket?cardIframeTicket=${encodeURIComponent(registered.ticket!)}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("ticketed");

    const denied = await app.request("/api/cards/c_ticket?cardIframeTicket=nope");
    expect(denied.status).toBe(403);
  });

  it("GET on an unknown cardId returns 404", async () => {
    const app = buildApp();
    const get = await app.request("/api/cards/c_missing");
    expect(get.status).toBe(404);
  });

  it("allows inline card code while blocking every external side-effect channel", async () => {
    const app = buildApp();
    await putCard(app, "c_csp", { code: "<div>x</div>" });
    const get = await app.request("/api/cards/c_csp");
    const csp = get.headers.get("content-security-policy");

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("navigate-to 'none'");
    expect(csp).not.toMatch(/https?:/);
  });

  it("rejects PUT without code (no silent fallback)", async () => {
    const app = buildApp();
    const res = await putCard(app, "c_nocode", { title: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid cardId on both PUT and GET", async () => {
    const app = buildApp();
    const put = await putCard(app, "bad id!", { code: "<div>x</div>" });
    expect(put.status).toBe(400);
    const get = await app.request("/api/cards/bad%20id!");
    expect(get.status).toBe(400);
  });

  it("rejects oversized code with 413", async () => {
    const app = buildApp();
    const huge = "x".repeat(512 * 1024 + 1);
    const res = await putCard(app, "c_huge", { code: huge });
    expect(res.status).toBe(413);
  });

  it("keeps every viewer ticket for the same card content", async () => {
    const app = buildApp();
    const register = () => putCard(app, "shared-card", { code: "<p>same card</p>" });
    const first = await (await register()).json() as { ticket: string };
    expect((await app.request(`/api/cards/shared-card?cardIframeTicket=${first.ticket}`)).status).toBe(200);
    const second = await (await register()).json() as { ticket: string };
    expect(second.ticket).not.toBe(first.ticket);
    expect((await app.request(`/api/cards/shared-card?cardIframeTicket=${first.ticket}`)).status).toBe(200);
    expect((await app.request(`/api/cards/shared-card?cardIframeTicket=${second.ticket}`)).status).toBe(200);
    expect((await app.request("/api/cards/shared-card?cardIframeTicket=nope")).status).toBe(403);
  });

  it("drops tickets when the immutable content changes and bounds the live set", async () => {
    const app = buildApp();
    const tickets: string[] = [];
    for (let i = 0; i < CARD_VIEW_TICKET_LIMIT + 1; i++) {
      const registered = await (await putCard(app, "bounded-card", { code: "<p>v1</p>", varsCss: "--a:1;" })).json() as { ticket: string };
      tickets.push(registered.ticket);
    }
    expect((await app.request(`/api/cards/bounded-card?cardIframeTicket=${tickets[0]}`)).status).toBe(403);
    expect((await app.request(`/api/cards/bounded-card?cardIframeTicket=${tickets[1]}`)).status).toBe(200);
    expect((await app.request(`/api/cards/bounded-card?cardIframeTicket=${tickets[CARD_VIEW_TICKET_LIMIT]}`)).status).toBe(200);

    const next = await (await putCard(app, "bounded-card", { code: "<p>v2</p>", varsCss: "--a:1;" })).json() as { ticket: string };
    expect((await app.request(`/api/cards/bounded-card?cardIframeTicket=${tickets[CARD_VIEW_TICKET_LIMIT]}`)).status).toBe(403);
    expect((await app.request(`/api/cards/bounded-card?cardIframeTicket=${next.ticket}`)).status).toBe(200);
    expect(await (await app.request(`/api/cards/bounded-card?cardIframeTicket=${next.ticket}`)).text()).toContain("<p>v2</p>");
  });

  it("keeps independent theme tickets for the same code without cross-rendering", async () => {
    const app = buildApp();
    const code = "<p>same card</p>";
    const dark = await (await putCard(app, "themed-card", { code, varsCss: "--accent: #111;" })).json() as { ticket: string };
    const light = await (await putCard(app, "themed-card", { code, varsCss: "--accent: #eee;" })).json() as { ticket: string };
    expect(light.ticket).not.toBe(dark.ticket);

    const darkResponse = await app.request(`/api/cards/themed-card?cardIframeTicket=${dark.ticket}`);
    const lightResponse = await app.request(`/api/cards/themed-card?cardIframeTicket=${light.ticket}`);
    expect(darkResponse.status).toBe(200);
    expect(lightResponse.status).toBe(200);
    const darkHtml = await darkResponse.text();
    const lightHtml = await lightResponse.text();
    expect(darkHtml).toContain(code);
    expect(lightHtml).toContain(code);
    expect(darkHtml).toContain("--accent: #111;");
    expect(darkHtml).not.toContain("--accent: #eee;");
    expect(lightHtml).toContain("--accent: #eee;");
    expect(lightHtml).not.toContain("--accent: #111;");

    const newer = await (await putCard(app, "themed-card", { code: "<p>newer card</p>", varsCss: "--accent: #111;" })).json() as { ticket: string };
    expect((await app.request(`/api/cards/themed-card?cardIframeTicket=${dark.ticket}`)).status).toBe(403);
    expect((await app.request(`/api/cards/themed-card?cardIframeTicket=${light.ticket}`)).status).toBe(403);
    const newerHtml = await (await app.request(`/api/cards/themed-card?cardIframeTicket=${newer.ticket}`)).text();
    expect(newerHtml).toContain("<p>newer card</p>");
    expect(newerHtml).not.toContain("<p>same card</p>");
  });

  it("evicts the oldest card once capacity (256) is exceeded", async () => {
    const app = buildApp();
    // 注册 257 张：c_0 应被淘汰，c_256 与 c_1 仍在。
    for (let i = 0; i < 257; i++) {
      const res = await putCard(app, `c_${i}`, { code: `<div>card ${i}</div>` });
      expect(res.status).toBe(200);
    }
    const evicted = await app.request("/api/cards/c_0");
    expect(evicted.status).toBe(404);
    const newest = await app.request("/api/cards/c_256");
    expect(newest.status).toBe(200);
  });
});
