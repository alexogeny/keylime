import { describe, expect, test } from "bun:test";
import { registerClarificationExtension } from "../extensions/clarification";

describe("clarification command proof of concept", () => {
  test("builds a deterministic evidence packet, stores one synthesized draft, and submits it verbatim", async () => {
    const commands: Record<string, any> = {};
    const handlers: Record<string, any[]> = {};
    const entries: any[] = [];
    const sent: Array<{ text: string; options: any }> = [];
    const notifications: string[] = [];
    let synthesisCalls = 0;
    const pi = {
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      appendEntry: (customType: string, data: any) => { entries.push({ type: "custom", customType, data }); },
      sendUserMessage: (text: string, options: any) => { sent.push({ text, options }); },
    } as any;
    registerClarificationExtension(pi, {
      collectDocuments: async () => [{ path: "extensions/fetch.ts", content: "function detectChallenge() {}" }],
      loadWebResearch: async () => [],
      synthesize: async packet => {
        synthesisCalls += 1;
        expect(packet.evidence[0]?.path).toBe("extensions/fetch.ts");
        return {
          title: "Harden challenge fallback",
          prompt: "# Task\nHarden challenge fallback.\n\n## Acceptance Criteria\n- Add focused coverage.",
          source: "llm",
        };
      },
    });
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      mode: "rpc",
      sessionManager: { getEntries: () => entries },
      ui: { notify: (text: string) => notifications.push(text) },
    } as any;

    await commands.clarify.handler("make challenge pages use firecrawl", ctx);

    expect(synthesisCalls).toBe(1);
    expect(sent).toHaveLength(0);
    expect(entries.at(-1)?.customType).toBe("clarification-draft");
    expect(notifications.at(-1)).toContain("Harden challenge fallback");

    await commands["submit-clarified"].handler("", ctx);

    expect(sent).toEqual([{
      text: "# Task\nHarden challenge fallback.\n\n## Acceptance Criteria\n- Add focused coverage.",
      options: { deliverAs: "followUp" },
    }]);
    expect(entries.at(-1)?.customType).toBe("clarification-submitted");
  });

  test("rejects empty clarification requests and missing drafts", async () => {
    const commands: Record<string, any> = {};
    const notifications: string[] = [];
    const pi = {
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      on: () => {},
      appendEntry: () => {},
      sendUserMessage: () => { throw new Error("must not submit"); },
    } as any;
    registerClarificationExtension(pi, {
      collectDocuments: async () => [],
      loadWebResearch: async () => [],
      synthesize: async () => { throw new Error("must not synthesize"); },
    });
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      mode: "rpc",
      sessionManager: { getEntries: () => [] },
      ui: { notify: (text: string) => notifications.push(text) },
    } as any;

    await commands.clarify.handler("", ctx);
    await commands["submit-clarified"].handler("", ctx);

    expect(notifications[0]).toContain("Usage: /clarify");
    expect(notifications[1]).toContain("No clarified prompt");
  });
});
