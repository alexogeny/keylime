import { describe, expect, test } from "bun:test";
import webUi, { handleWebUiRequest, renderWebUiHtml, sanitizeProfile, webUiStateForTests } from "../extensions/web-ui";
import { mockPiFixture } from "./helpers/mock-pi";

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1${path}`, init);
}

describe("browser web UI extension", () => {
  test("registers web-ui commands and serves a modern shell", () => {
    const harness = mockPiFixture();
    webUi(harness.pi);
    expect(Object.keys(harness.commands)).toEqual(expect.arrayContaining(["web-ui", "web-ui-stop"]));
    const html = renderWebUiHtml();
    expect(html).toContain("Keylime Browser UI");
    expect(html).toContain("Memory");
    expect(html).toContain("Tools");
    expect(html).toContain("Profile");
    expect(html).toContain("Research");
    expect(html).toContain("Models & Pi");
    expect(html).toContain("https://cdn.jsdelivr.net/npm/@picocss/pico");
    expect(html).not.toContain(">Structured Memory<");
    expect(html).toContain("type=\"file\"");
    expect(html).toContain("chatLog");
    expect(html).not.toContain('data-tab="theme"');
    expect(html).not.toContain("Avatar data URL");
    expect(html).toContain("localStorage.getItem('keylime.token')");
  });

  test("rendered browser script parses", () => {
    const html = renderWebUiHtml();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  test("profile sanitizer keeps first-class profile settings bounded", () => {
    const profile = sanitizeProfile({
      nickname: "Andie",
      avatarDataUrl: "data:image/png;base64,abc",
      theme: "aurora",
      customInstructions: "x".repeat(20_000),
    });
    expect(profile.nickname).toBe("Andie");
    expect(profile.avatarDataUrl).toBe("data:image/png;base64,abc");
    expect(profile.theme).toBe("aurora");
    expect(profile.customInstructions.length).toBeLessThanOrEqual(8000);
  });

  test("HTTP handler exposes health and blocks unsafe methods", async () => {
    const state = webUiStateForTests({ cwd: process.cwd() });
    const health = await handleWebUiRequest(req("/api/health"), state);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const blocked = await handleWebUiRequest(req("/api/profile", { method: "DELETE" }), state);
    expect(blocked.status).toBe(405);
  });

  test("HTTP handler requires bearer token when configured", async () => {
    const state = webUiStateForTests({ cwd: process.cwd(), token: "secret" });
    const denied = await handleWebUiRequest(req("/api/health"), state);
    expect(denied.status).toBe(401);

    const allowed = await handleWebUiRequest(req("/api/health", { headers: { Authorization: "Bearer secret" } }), state);
    expect(allowed.status).toBe(200);
  });

  test("research API returns searchable topic index shape", async () => {
    const state = webUiStateForTests({ cwd: process.cwd() });
    const response = await handleWebUiRequest(req("/api/research?q=llm"), state);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("entries");
    expect(body).toHaveProperty("stats");
  });

  test("chat POST delegates through state sender and persists browser thread history", async () => {
    const sent: string[] = [];
    const state = webUiStateForTests({ cwd: process.cwd(), sendUserMessage: (text: string) => sent.push(text), dataDir: await Bun.file('/tmp').exists() ? `/tmp/keylime-web-ui-test-${Date.now()}` : undefined });
    const response = await handleWebUiRequest(req("/api/chat", { method: "POST", body: JSON.stringify({ message: "hello pi about memory ui" }) }), state);
    expect(response.status).toBe(200);
    expect(sent).toEqual(["hello pi about memory ui"]);
    const threads = await handleWebUiRequest(req("/api/chat-threads"), state);
    const body = await threads.json();
    expect(body.threads[0].topics).toContain("memory");
    expect(body.threads[0].messages[0].content).toBe("hello pi about memory ui");
  });

  test("structured memory endpoint separates profile, timeline, and other memories", async () => {
    const state = webUiStateForTests({ cwd: process.cwd() });
    const response = await handleWebUiRequest(req("/api/memory-profile"), state);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("profile");
    expect(body).toHaveProperty("timeline");
    expect(body).toHaveProperty("memories");
  });
});
