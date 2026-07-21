import { describe, expect, test } from "bun:test";

const extensionPath = "../../extensions/session-handoff";
async function extensionApi(): Promise<any> { return import(extensionPath); }

function createHost() {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: string[] = [];
  return {
    commands, handlers, entries, messages,
    api: {
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, handler: any) => handlers.set(name, handler),
      appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
      sendUserMessage: (message: string) => messages.push(message),
    },
  };
}

describe("RED: executable Pi handoff extension", () => {
  test("TE-058 registers an explicit /handoff command and session-start consumer", async () => {
    const host = createHost();
    const extension = await extensionApi();
    extension.default(host.api);
    expect(host.commands.has("handoff")).toBe(true);
    expect(host.handlers.has("session_start")).toBe(true);
  });

  test("TE-059 persists one typed checkpoint instead of replaying the transcript", async () => {
    const host = createHost();
    const extension = await extensionApi();
    extension.default(host.api);
    await host.commands.get("handoff").handler("continue token work", {
      sessionManager: { getBranch: () => Array.from({ length: 100 }, (_, index) => ({ type: "message", message: { role: "user", content: `private turn ${index}` } })) },
      ui: { notify: () => {} },
    });
    expect(host.entries).toHaveLength(1);
    expect(host.entries[0].type).toBe("token-efficiency-handoff");
    expect(JSON.stringify(host.entries[0])).not.toContain("private turn 99");
  });

  test("TE-059b consumes a checkpoint once and injects only the bounded bootstrap", async () => {
    const host = createHost();
    const extension = await extensionApi();
    extension.default(host.api);
    await host.handlers.get("session_start")({ entries: [{ type: "custom", customType: "token-efficiency-handoff", data: { id: "h1", bootstrap: "bounded state" } }] }, { sessionManager: { getEntries: () => [] } });
    await host.handlers.get("session_start")({ entries: [{ type: "custom", customType: "token-efficiency-handoff", data: { id: "h1", bootstrap: "bounded state" } }] }, { sessionManager: { getEntries: () => [] } });
    expect(host.messages).toEqual(["bounded state"]);
  });
});
