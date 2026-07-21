import { describe, expect, test } from "bun:test";
import contextRuntimeExtension from "../../extensions/context-runtime";
import usageTrackerExtension from "../../extensions/usage-tracker";
import sessionHandoffExtension from "../../extensions/session-handoff";
import { applyRouteTools } from "../../extensions/intent-router";
import { selectCompactionGenerationModel } from "../../extensions/structured-compaction";

function extensionHost() {
  const handlers: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const entries: any[] = [];
  return {
    handlers, commands, entries,
    api: {
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerTool: () => {}, registerCommand: (name: string, command: any) => { commands[name] = command; },
      appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
      sendUserMessage: () => {}, getThinkingLevel: () => "off",
    },
  };
}

const ctx = () => ({
  model: { id: "claude", provider: "anthropic" },
  sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "s1", getSessionFile: () => "s1.jsonl" },
  getContextUsage: () => ({ tokens: 10_000, percent: 20, contextWindow: 50_000 }),
  ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_style: string, text: string) => text } },
});

describe("RED: production Pi hooks use token-efficiency policies", () => {
  test("TE-090 live context hook invokes trajectory reducer for cold recoverable results", async () => {
    const host = extensionHost();
    contextRuntimeExtension(host.api as any);
    const context = ctx();
    await host.handlers.session_start({ reason: "new" }, context);
    await host.handlers.tool_result({ toolCallId: "c1", toolName: "inspect_lines", content: [{ type: "text", text: "large result".repeat(500) }], details: { contextObjectId: "ctx-1" }, isError: false });
    for (let index = 0; index < 10; index++) await host.handlers.turn_end({}, context);
    const result = await host.handlers.context({ messages: [{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "large result".repeat(500) }], details: { contextObjectId: "ctx-1" } }] }, context);
    expect(result.messages[0].details.contextRuntimeReducer).toBe("trajectory-reducer");
    expect(JSON.stringify(result.messages[0].content)).toContain("ctx-1");
  });

  test("TE-091 before_provider_request applies Anthropic cache controls in production", async () => {
    const host = extensionHost();
    usageTrackerExtension(host.api as any);
    await host.handlers.turn_start({ turnIndex: 1 });
    const result = await host.handlers.before_provider_request({ payload: { model: "claude", system: "stable", tools: [], messages: [] } }, ctx());
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(result.system).toBe("stable");
  });

  test("TE-092 usage hook persists safe prefix and normalized spend diagnostics", async () => {
    const host = extensionHost();
    usageTrackerExtension(host.api as any);
    const context = ctx();
    await host.handlers.session_start({}, context);
    await host.handlers.turn_start({ turnIndex: 1 });
    await host.handlers.before_provider_request({ payload: { model: "claude", system: "PRIVATE_SYSTEM", tools: [], messages: [] } }, context);
    await host.handlers.message_end({ message: { role: "assistant", usage: { input: 20, output: 3, cacheRead: 80, cost: { total: 0.01 } } } }, context);
    const record = host.entries.find(entry => entry.type === "usage-record-v2")?.data;
    expect(record.spend.currentTurn).toMatchObject({ uncachedInputTokens: 20, cacheReadTokens: 80, outputTokens: 3, costUsd: 0.01 });
    expect(record.promptPrefix.current.hash).toHaveLength(64);
    expect(JSON.stringify(record.promptPrefix)).not.toContain("PRIVATE_SYSTEM");
  });

  test("TE-093 /handoff uses ctx.newSession with only the bounded bootstrap", async () => {
    const host = extensionHost();
    sessionHandoffExtension(host.api as any);
    const appended: any[] = [];
    const context: any = ctx();
    context.waitForIdle = async () => {};
    context.newSession = async (options: any) => { await options.setup({ appendMessage: (message: any) => appended.push(message) }); return { cancelled: false }; };
    await host.commands.handoff.handler("continue token work", context);
    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended[0])).toContain("continue token work");
    expect(JSON.stringify(appended[0])).not.toContain("large result");
  });

  test("TE-095 intent routing applies one canonical tool order even when the current order drifts", () => {
    const available = ["run_checks", "inspect_lines", "code_search", "custom_safe_tool"].map(name => ({ name }));
    const calls: string[][] = [];
    let current = ["run_checks", "inspect_lines", "code_search", "custom_safe_tool"];
    const pi: any = {
      getAllTools: () => available,
      getActiveTools: () => current,
      setActiveTools: (names: string[]) => { calls.push(names); current = names; },
    };
    applyRouteTools(pi, { primaryIntent: "coding", capabilityGroups: ["coding"], confidence: 1 } as any);
    current = [...current].reverse();
    applyRouteTools(pi, { primaryIntent: "coding", capabilityGroups: ["coding"], confidence: 1 } as any);
    expect(calls.at(-1)).toEqual([...calls.at(-1)!].sort());
  });

  test("TE-096 structured compaction uses an optional sidecar without switching the main model", () => {
    const previous = process.env.KEYLIME_COMPACTION_SIDECAR_MODEL;
    process.env.KEYLIME_COMPACTION_SIDECAR_MODEL = "anthropic/haiku";
    const main = { provider: "anthropic", id: "opus" };
    const sidecar = { provider: "anthropic", id: "haiku" };
    const context: any = { model: main, modelRegistry: { find: (provider: string, id: string) => provider === "anthropic" && id === "haiku" ? sidecar : undefined } };
    expect(selectCompactionGenerationModel(context)).toBe(sidecar);
    expect(context.model).toBe(main);
    if (previous === undefined) delete process.env.KEYLIME_COMPACTION_SIDECAR_MODEL;
    else process.env.KEYLIME_COMPACTION_SIDECAR_MODEL = previous;
  });

  test("TE-094 /handoff bootstraps durable constraints, plans, failures, files, and verification", async () => {
    const host = extensionHost();
    sessionHandoffExtension(host.api as any);
    const appended: any[] = [];
    const context: any = ctx();
    context.sessionManager.getBranch = () => [{ type: "custom", customType: "context-runtime-v1", data: {
      controlState: {
        constraints: [{ sourceEventId: "c1", text: "Do not change public APIs" }],
        plans: [{ sourceEventId: "p1", text: "Wire the live hooks" }],
        unresolvedFailures: [{ sourceEventId: "f1", text: "Cache miss remains" }],
      },
      retrieval: { modifiedPaths: ["extensions/usage-tracker.ts"], verificationPassed: true },
    } }];
    context.waitForIdle = async () => {};
    context.newSession = async (options: any) => { await options.setup({ appendMessage: (message: any) => appended.push(message) }); return { cancelled: false }; };
    await host.commands.handoff.handler("continue token work", context);
    const bootstrap = JSON.stringify(appended[0]);
    expect(bootstrap).toContain("Do not change public APIs");
    expect(bootstrap).toContain("Wire the live hooks");
    expect(bootstrap).toContain("Cache miss remains");
    expect(bootstrap).toContain("extensions/usage-tracker.ts");
    expect(bootstrap).toContain("verificationPassed");
  });
});
