import { describe, expect, test } from "bun:test";
import controlPlaneApi, { handleControlPlaneRequest, runtimeState } from "../extensions/control-plane-api";
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
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining(["model_select", "thinking_level_select", "turn_start", "turn_end", "tool_call"]));
  });

  test("system and status endpoints expose normalized control-plane shape", async () => {
    const state = { cwd: process.cwd(), runtime: { agentState: "idle", model: { id: "claude-test", provider: "anthropic" } } } as any;
    const system = await handleControlPlaneRequest(req("/api/system"), state);
    expect(system.status).toBe(200);
    const s = await body(system);
    expect(s.ok).toBe(true);
    expect(s.data.capabilities.chat).toBe(true);
    expect(s.data.capabilities.structuredMemory).toBe(true);

    const status = await body(await handleControlPlaneRequest(req("/api/status"), state));
    expect(status.data.workspace.path).toBe(process.cwd());
    expect(status.data.model).toMatchObject({ id: "claude-test", provider: "anthropic" });
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

  test("mutation surfaces exist and fail explicitly when backend adapters are missing", async () => {
    const state = { cwd: process.cwd(), runtime: runtimeState } as any;
    const paths = [
      ["/api/approvals/a1/approve", "POST"],
      ["/api/approvals/a1/files/src%2Fapp.ts/approve", "POST"],
      ["/api/patches/p1/hunks/h1/approve", "POST"],
      ["/api/memory/m1", "PATCH"],
      ["/api/memory/m1/exclude", "POST"],
      ["/api/chat/threads", "POST"],
      ["/api/chat/messages/m1/pin", "POST"],
      ["/api/chat/interrupt", "POST"],
      ["/api/tools/code_search/invoke", "POST"],
      ["/api/tools/code_search/permission", "PATCH"],
      ["/api/runs/r1/cancel", "POST"],
      ["/api/graph/edges", "POST"],
      ["/api/workspace/context", "POST"],
      ["/api/workspace/files/src%2Fapp.ts/rollback", "POST"],
      ["/api/models/default", "PUT"],
      ["/api/settings/privacy", "PATCH"],
      ["/api/providers/openai/connect", "POST"],
      ["/api/providers/openai/keys", "POST"],
      ["/api/workspaces/select", "POST"],
      ["/api/attachments", "POST"],
    ] as const;
    for (const [path, method] of paths) {
      const response = await handleControlPlaneRequest(req(path, { method, body: method === "PATCH" || method === "POST" || method === "PUT" ? "{}" : undefined }), state);
      const payload = await body(response);
      expect(response.status).toBe(501);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe("BACKEND_UNSUPPORTED");
    }
  });

  test("generic actions and provider/attachment read surfaces are present", async () => {
    const state = { cwd: process.cwd(), runtime: runtimeState } as any;
    const action = await body(await handleControlPlaneRequest(req("/api/actions", { method: "POST", body: JSON.stringify({ type: "custom.do" }) }), state));
    expect(action.data.status).toBe("unsupported");
    const providers = await body(await handleControlPlaneRequest(req("/api/providers"), state));
    expect(providers.data.providers).toEqual([]);
    const attachments = await body(await handleControlPlaneRequest(req("/api/attachments"), state));
    expect(attachments.data.attachments).toEqual([]);
  });
});
