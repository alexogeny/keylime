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
});
