import { describe, expect, test } from "bun:test";

async function text(path: string) { return Bun.file(path).text(); }

describe("graphite control-plane UI", () => {
  test("main shell loads API client and wires live state hooks", async () => {
    const html = await text("ui/keylime.dc.html");
    expect(html).toContain("./keylime-api.js");
    expect(html).toContain("./shared.css");
    expect(html).toContain("./shared-components.js");
    expect(html).toContain("loadApi()");
    expect(html).toContain("KeylimeAPI.loadAll");
    expect(html).toContain("/api/chat/threads/current/messages");
    expect(html).toContain("api?.status?.model");
    for (const view of ["Dashboard.dc.html", "ChatView.dc.html", "Research.dc.html", "MemoryBrowser.dc.html", "GraphView.dc.html", "FilesView.dc.html", "ToolsView.dc.html", "ApprovalsView.dc.html", "RunsView.dc.html", "SettingsView.dc.html"]) {
      expect(html).toContain(`src="./${view}"`);
    }
  });

  test("shared UI assets expose reusable frame/style primitives", async () => {
    expect(await text("ui/shared.css")).toContain(".kl-frame");
    expect(await text("ui/shared-components.js")).toContain("KeylimeComponents");
  });

  test("API client targets contract endpoints", async () => {
    const js = await text("ui/keylime-api.js");
    for (const route of ["/api/system", "/api/status", "/api/screens/dashboard", "/api/chat/threads/current", "/api/research", "/api/memory", "/api/graph", "/api/workspace", "/api/runs", "/api/tools", "/api/approvals", "/api/models", "/api/settings", "/api/patches", "/api/events"]) {
      expect(js).toContain(route);
    }
    expect(js).toContain("EventSource");
  });

  test("split view files exist for remaining major panes", async () => {
    for (const path of ["ui/RunsView.dc.html", "ui/SettingsView.dc.html", "ui/ChatView.dc.html", "ui/Research.dc.html", "ui/MemoryBrowser.dc.html", "ui/ToolsView.dc.html", "ui/ApprovalsView.dc.html", "ui/FilesView.dc.html", "ui/GraphView.dc.html"]) {
      const html = await text(path);
      expect(html).toContain("<x-dc>");
      expect(html).toContain("./keylime-api.js");
      expect(html).toContain("./shared.css");
      expect(html).toContain("./shared-components.js");
    }
  });
});
