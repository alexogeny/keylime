import { describe, expect, test } from "bun:test";
import controlPlaneApi, { handleControlPlaneRequest, runtimeState, startControlPlaneServer, stopControlPlaneServer } from "../extensions/control-plane-api";
import { mockPiFixture } from "./helpers/mock-pi";

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1${path}`, init);
}

async function body(response: Response) {
  return response.json() as Promise<any>;
}

describe("control-plane API extension", () => {
  test("registers adaptive lifecycle handlers without web-ui commands", () => {
    const harness = mockPiFixture();
    controlPlaneApi(harness.pi);
    expect(Object.keys(harness.commands)).not.toContain("web-ui");
    expect(Object.keys(harness.commands)).not.toContain("web-ui-stop");
    expect(Object.keys(harness.commands)).toEqual(expect.arrayContaining(["keylime", "keylime-stop"]));
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining(["model_select", "thinking_level_select", "turn_start", "turn_end", "tool_call"]));
  });

  test("serves branded graphite UI and API from keylime server", async () => {
    const harness = mockPiFixture();
    const ctx = { cwd: process.cwd(), sessionManager: { getEntries: () => [] }, ui: { notify: () => {} } } as any;
    const url = await startControlPlaneServer(harness.pi, ctx, 0);
    try {
      const html = await fetch(`${url}ui/keylime.dc.html`);
      expect(html.status).toBe(200);
      expect(await html.text()).toContain("KEYLIME");
      const api = await fetch(`${url}api/system`);
      expect(api.status).toBe(200);
    } finally {
      await stopControlPlaneServer();
    }
  });

  test("system and status endpoints expose normalized control-plane shape", async () => {
    const state = { cwd: process.cwd(), runtime: { agentState: "idle", model: { id: "claude-test", provider: "anthropic" } } } as any;
    const system = await handleControlPlaneRequest(req("/api/system"), state);
    expect(system.status).toBe(200);
    const s = await body(system);
    expect(s.ok).toBe(true);
    expect(s.data.capabilities).toEqual(expect.arrayContaining(["chat", "memory", "research", "files", "patches", "models", "approvals", "tools", "graph", "runs", "modelSwitch"]));
    expect(s.data.capabilityMap.structuredMemory).toBe(true);

    const status = await body(await handleControlPlaneRequest(req("/api/status"), state));
    expect(status.data.workspace.path).toBe(process.cwd());
    expect(status.data.model).toMatchObject({ id: "claude-test", provider: "anthropic" });
    expect(status.data.provider).toMatchObject({ name: "anthropic" });
    expect(status.data.agentState).toBe("idle");
    expect(status.data.tokens).toHaveProperty("used");
    expect(status.data.counts).toHaveProperty("approvalsPending");
  });

  test("chat endpoint normalizes current session entries and sends messages", async () => {
    const sent: any[] = [];
    const state = {
      cwd: process.cwd(),
      getEntries: () => [{ id: "u1", role: "user", content: "hello" }, { id: "a1", role: "assistant", content: "hi" }],
      sendUserMessage: (text: string, options: any) => sent.push({ text, options }),
      runtime: runtimeState,
    } as any;
    const thread = await body(await handleControlPlaneRequest(req("/api/chat/threads/current"), state));
    expect(thread.data.messages.map((m: any) => m.content)).toEqual(["hello", "hi"]);

    const posted = await handleControlPlaneRequest(req("/api/chat/threads/current/messages", { method: "POST", body: JSON.stringify({ content: "do the thing", mode: "followUp" }) }), state);
    expect(posted.status).toBe(202);
    expect(sent).toEqual([{ text: "do the thing", options: { deliverAs: "followUp" } }]);
  });

  test("screen bundles provide prototype-friendly data", async () => {
    const state = { cwd: process.cwd(), getEntries: () => [], runtime: runtimeState } as any;
    const dashboard = await body(await handleControlPlaneRequest(req("/api/screens/dashboard"), state));
    expect(dashboard.ok).toBe(true);
    expect(dashboard.data).toHaveProperty("status");
    expect(dashboard.data).toHaveProperty("threads");
    expect(dashboard.data).toHaveProperty("activity");

    const memory = await body(await handleControlPlaneRequest(req("/api/screens/memory"), state));
    expect(memory.data).toHaveProperty("profile");
    expect(memory.data).toHaveProperty("timelines");
    expect(memory.data).toHaveProperty("entities");
  });

  test("auth protects every API route when configured", async () => {
    const state = { cwd: process.cwd(), token: "secret", runtime: runtimeState } as any;
    const denied = await handleControlPlaneRequest(req("/api/system"), state);
    expect(denied.status).toBe(401);
    const allowed = await handleControlPlaneRequest(req("/api/system", { headers: { authorization: "Bearer secret" } }), state);
    expect(allowed.status).toBe(200);
  });

  test("mutation surfaces persist functional control-plane state", async () => {
    const dataDir = `/tmp/keylime-control-plane-test-${Date.now()}-${Math.random()}`;
    const state = { cwd: process.cwd(), dataDir, memoryFile: `${dataDir}/memories.json`, runtime: { agentState: "idle" } } as any;

    expect((await body(await handleControlPlaneRequest(req("/api/approvals/a1/approve", { method: "POST", body: "{}" }), state))).data.approval.status).toBe("approved");
    expect((await body(await handleControlPlaneRequest(req("/api/patches/p1/hunks/h1/approve", { method: "POST", body: "{}" }), state))).data.patch.status).toBe("approved");

    const createdMemory = await body(await handleControlPlaneRequest(req("/api/memory", { method: "POST", body: JSON.stringify({ content: "likes graphite UIs", category: "preference" }) }), state));
    const memoryId = createdMemory.data.memory.id;
    expect((await body(await handleControlPlaneRequest(req(`/api/memory/${memoryId}`, { method: "PATCH", body: JSON.stringify({ tags: ["ui"] }) }), state))).data.memory.tags).toEqual(["ui"]);
    expect((await body(await handleControlPlaneRequest(req(`/api/memory/${memoryId}/exclude`, { method: "POST", body: "{}" }), state))).data.memory.excluded).toBe(true);

    const thread = await body(await handleControlPlaneRequest(req("/api/chat/threads", { method: "POST", body: JSON.stringify({ title: "Prototype" }) }), state));
    const threadId = thread.data.thread.id;
    expect((await body(await handleControlPlaneRequest(req(`/api/chat/threads/${threadId}/branch`, { method: "POST", body: "{}" }), state))).data.thread.branchedFrom).toBe(threadId);
    expect((await body(await handleControlPlaneRequest(req("/api/chat/messages/m1/pin", { method: "POST", body: "{}" }), state))).data.message.pinned).toBe(true);

    expect((await body(await handleControlPlaneRequest(req("/api/tools/code_search/invoke", { method: "POST", body: JSON.stringify({ query: "x" }) }), state))).data.invocation.status).toBe("queued");
    expect((await body(await handleControlPlaneRequest(req("/api/tools/code_search/permission", { method: "PATCH", body: JSON.stringify({ mode: "blocked" }) }), state))).data.permission.mode).toBe("blocked");
    expect((await body(await handleControlPlaneRequest(req("/api/runs/r1/cancel", { method: "POST", body: "{}" }), state))).data.control.action).toBe("cancel");

    expect((await body(await handleControlPlaneRequest(req("/api/graph/edges", { method: "POST", body: JSON.stringify({ from: "a", to: "b", type: "related" }) }), state))).data.edge.type).toBe("related");
    expect((await body(await handleControlPlaneRequest(req("/api/workspace/context", { method: "POST", body: JSON.stringify({ path: "README.md" }) }), state))).data.context.path).toBe("README.md");
    expect((await body(await handleControlPlaneRequest(req("/api/workspace/files/src%2Fapp.ts/rollback", { method: "POST", body: "{}" }), state))).data.change.action).toBe("rollback");

    expect((await body(await handleControlPlaneRequest(req("/api/models/select", { method: "POST", body: JSON.stringify({ modelId: "gpt-test", provider: "openai" }) }), state))).data.current.id).toBe("gpt-test");
    expect((await body(await handleControlPlaneRequest(req("/api/models/default", { method: "PUT", body: JSON.stringify({ modelId: "gpt-test", scope: "workspace" }) }), state))).data.defaults.workspace).toBe("gpt-test");
    expect((await body(await handleControlPlaneRequest(req("/api/settings/privacy", { method: "PATCH", body: JSON.stringify({ localOnly: true }) }), state))).data.privacy.localOnly).toBe(true);

    expect((await body(await handleControlPlaneRequest(req("/api/providers/openai/connect", { method: "POST", body: JSON.stringify({ apiKey: "secret", label: "OpenAI" }) }), state))).data.provider.apiKey).toBe("********");
    expect((await body(await handleControlPlaneRequest(req("/api/providers/openai/keys", { method: "POST", body: JSON.stringify({ key: "secret" }) }), state))).data.provider.keys[0].redacted).toBe("********");
    expect((await body(await handleControlPlaneRequest(req("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Lab", path: "/tmp/lab" }) }), state))).data.workspace.name).toBe("Lab");
    expect((await body(await handleControlPlaneRequest(req("/api/attachments", { method: "POST", body: JSON.stringify({ name: "note.txt", content: "hello" }) }), state))).data.attachment.name).toBe("note.txt");
  });

  test("generic actions and provider/attachment read surfaces are present", async () => {
    const dataDir = `/tmp/keylime-control-plane-test-${Date.now()}-${Math.random()}`;
    const state = { cwd: process.cwd(), dataDir, runtime: runtimeState } as any;
    const action = await body(await handleControlPlaneRequest(req("/api/actions", { method: "POST", body: JSON.stringify({ type: "custom.do" }) }), state));
    expect(action.data.status).toBe("queued");
    const providers = await body(await handleControlPlaneRequest(req("/api/providers"), state));
    expect(providers.data.items).toEqual([]);
    const attachments = await body(await handleControlPlaneRequest(req("/api/attachments"), state));
    expect(attachments.data.items).toEqual([]);
  });

  test("frontend contract aliases return items and detail shapes", async () => {
    const dataDir = `/tmp/keylime-control-plane-test-${Date.now()}-${Math.random()}`;
    const state = { cwd: process.cwd(), dataDir, memoryFile: `${dataDir}/memories.json`, runtime: { agentState: "idle", model: { id: "m", provider: "p" } } } as any;
    const threads = await body(await handleControlPlaneRequest(req("/api/chat/threads?q=current"), state));
    expect(Array.isArray(threads.data.items)).toBe(true);
    const runs = await body(await handleControlPlaneRequest(req("/api/runs?window=24h"), state));
    expect(Array.isArray(runs.data.items)).toBe(true);
    const tools = await body(await handleControlPlaneRequest(req("/api/tools"), state));
    expect(Array.isArray(tools.data.items)).toBe(true);
    const models = await body(await handleControlPlaneRequest(req("/api/models"), state));
    expect(models.data.items[0]).toMatchObject({ provider: "p", active: true });
    const settings = await body(await handleControlPlaneRequest(req("/api/settings"), state));
    expect(settings.data).toHaveProperty("memorySettings");
    expect(settings.data).toHaveProperty("agentDefaults");
    const search = await body(await handleControlPlaneRequest(req("/api/search?q=read"), state));
    expect(search.data).toHaveProperty("threads");
    expect(search.data).toHaveProperty("files");
    const events = await handleControlPlaneRequest(req("/api/events?since=abc"), state);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(await events.text()).toContain("agent.state");
  });

  test("contract-specific mutations work", async () => {
    const dataDir = `/tmp/keylime-control-plane-test-${Date.now()}-${Math.random()}`;
    const state = { cwd: process.cwd(), dataDir, runtime: { agentState: "idle" } } as any;
    expect((await body(await handleControlPlaneRequest(req("/api/chat/threads/current/interrupt", { method: "POST", body: "{}" }), state))).data.control.action).toBe("cancel");
    expect((await body(await handleControlPlaneRequest(req("/api/chat/messages/m1/pin", { method: "POST", body: JSON.stringify({ pinned: false }) }), state))).data.message.pinned).toBe(false);
    expect((await body(await handleControlPlaneRequest(req("/api/chat/messages/m1/bookmark", { method: "POST", body: JSON.stringify({ bookmarked: true }) }), state))).data.message.bookmarked).toBe(true);
    expect((await body(await handleControlPlaneRequest(req("/api/approvals/a1/revoke", { method: "POST", body: "{}" }), state))).data.approval.status).toBe("pending");
    expect((await body(await handleControlPlaneRequest(req("/api/research/r1/pin", { method: "POST", body: JSON.stringify({ pinned: true }) }), state))).data.entry.pinned).toBe(true);
    expect((await body(await handleControlPlaneRequest(req("/api/tools/code_search", { method: "PATCH", body: JSON.stringify({ mode: "auto" }) }), state))).data.permission.mode).toBe("auto");
    const form = new FormData();
    form.set("file", new File(["abc"], "a.txt", { type: "text/plain" }));
    const upload = await body(await handleControlPlaneRequest(req("/api/attachments", { method: "POST", body: form }), state));
    expect(upload.data).toMatchObject({ name: "a.txt", size: 3 });
  });
});
