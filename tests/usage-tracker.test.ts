import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import usageTracker from "../extensions/usage-tracker";
import { buildContextLedgerRecord, setPendingContextLedgerRecord } from "../extensions/shared/context-ledger";

describe("usage tracker context records", () => {
  test("writes v2 cache telemetry without retaining message content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "usage-tracker-"));
    const oldCwd = process.cwd();
    const handlers: Record<string, any> = {};
    const entries: Array<{ type: string; data: any }> = [];
    try {
      process.chdir(cwd);
      usageTracker({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        appendEntry: (type: string, data: any) => { entries.push({ type, data }); },
        registerCommand: () => {},
      } as any);

      await handlers.turn_start({ turnIndex: 7 });
      setPendingContextLedgerRecord(buildContextLedgerRecord({
        ts: 100,
        activeToolNames: ["code_search"],
        parts: [{ category: "turn_provider", text: "bounded reminder" }],
        transforms: [],
      }));
      await handlers.message_end({
        message: {
          role: "assistant",
          content: "TOP_SECRET_MESSAGE_BODY",
          usage: { input: 100, output: 20, cacheRead: 75, cacheWrite: 10, cost: { total: 0.5 } },
        },
      }, { model: { id: "model-a", provider: "provider-a" } });

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("usage-record-v2");
      expect(entries[0].data).toMatchObject({
        version: 2,
        turnIndex: 7,
        input: 100,
        output: 20,
        cacheRead: 75,
        cacheWrite: 10,
        context: {
          totalChars: 16,
          categories: { turn_provider: { chars: 16 } },
        },
      });
      expect(JSON.stringify(entries[0].data)).not.toContain("TOP_SECRET_MESSAGE_BODY");
    } finally {
      process.chdir(oldCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("persists one privacy-safe task outcome and routing observation at agent_settled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "usage-task-outcome-"));
    const handlers: Record<string, any> = {};
    const entries: Array<{ type: string; data: any }> = [];
    try {
      usageTracker({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        appendEntry: (type: string, data: any) => { entries.push({ type, data }); },
        registerCommand: () => {},
        getActiveTools: () => ["apply_code_replacements", "run_checks"],
        getThinkingLevel: () => "low",
      } as any);
      const ctx = {
        cwd,
        model: { id: "model-a", provider: "provider-a" },
        getContextUsage: () => ({ percent: 20 }),
        sessionManager: { getEntries: () => [] },
      };
      await handlers.session_start({}, ctx);
      await handlers.before_agent_start({}, ctx);
      await handlers.tool_result({ toolName: "apply_code_replacements", isError: false, details: { changedPaths: ["src/a.ts"] } });
      await handlers.tool_result({ toolName: "run_checks", isError: false, details: { results: [{ command: "bun", args: ["test"], ok: true }] } });
      await handlers.turn_start({ turnIndex: 1 });
      await handlers.message_end({
        message: { role: "assistant", content: "PRIVATE_RESPONSE", usage: { input: 100, output: 20, cost: { total: .01 } } },
      }, ctx);
      await handlers.agent_settled({}, ctx);

      const outcome = entries.find(entry => entry.type === "task-outcome-v1")?.data;
      const routing = entries.find(entry => entry.type === "agent-routing-observation-v1")?.data;
      expect(outcome).toMatchObject({ outcome: "verified", changedPaths: ["src/a.ts"], usage: { modelCalls: 1, costUsd: .01 } });
      expect(routing).toMatchObject({ applied: false, outcome: "verified", successfulTaskCostUsd: .01 });
      expect(JSON.stringify({ outcome, routing })).not.toContain("PRIVATE_RESPONSE");
      expect(JSON.stringify({ outcome, routing })).not.toContain(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
