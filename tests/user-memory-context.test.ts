import { beforeEach, describe, expect, test } from "bun:test";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";
import { clearContextProviders, composeTurnContext } from "../extensions/shared/turn-context";
import { registerUserMemoryContext } from "../extensions/user-memory/context-provider";
import type { MemoryStore } from "../extensions/user-memory/store";
import type { EntityStore } from "../extensions/user-memory/entity";

const ctx = () => ({ getContextUsage: () => ({ percent: 10 }) }) as any;
const messages = (text: string) => [{ role: "user", content: text }];

function memoryStore(): MemoryStore {
  const now = Date.now();
  return {
    version: 4,
    profile: {},
    memories: [{
      id: "mem-1",
      content: "Andie project context should be available when explicitly mentioned",
      category: "context",
      tags: ["coding"],
      confidence: 1,
      created_at: now,
      updated_at: now,
      temporal: false,
      mentions: 1,
      first_seen: now,
      entity_refs: [],
    }],
  };
}

beforeEach(() => {
  clearContextProviders();
  setCurrentRoute(classifyIntent(""));
});

describe("user-memory context provider", () => {
  test("skips hybrid memory search on code routes without entity matches", async () => {
    let searchCalls = 0;
    registerUserMemoryContext({
      pi: { on: () => {} } as any,
      ensureLoaded: async () => {},
      getStore: memoryStore,
      getEntityStore: () => ({ version: 1, entities: [] }) as EntityStore,
      pendingHints: [],
      pendingClarifications: [],
      hybridSearch: async () => { searchCalls++; return []; },
    });

    setCurrentRoute({ ...classifyIntent(""), primaryIntent: "coding" });
    const result = await composeTurnContext(ctx(), messages("please refactor this module"));

    expect(searchCalls).toBe(0);
    expect(result.providerIds).not.toContain("user-memory");
  });

  test("allows entity-linked memory context on code routes", async () => {
    let searchCalls = 0;
    const store = memoryStore();
    const entityStore: EntityStore = {
      version: 1,
      entities: [{
        id: "ent-1",
        name: "Andie",
        type: "person",
        aliases: [],
        mentions: 1,
        memory_ids: ["mem-1"],
        created_at: Date.now(),
        updated_at: Date.now(),
      }],
    };
    registerUserMemoryContext({
      pi: { on: () => {} } as any,
      ensureLoaded: async () => {},
      getStore: () => store,
      getEntityStore: () => entityStore,
      pendingHints: [],
      pendingClarifications: [],
      hybridSearch: async () => { searchCalls++; return []; },
    });

    setCurrentRoute({ ...classifyIntent(""), primaryIntent: "coding" });
    const result = await composeTurnContext(ctx(), messages("refactor this for Andie"));
    const text = result.messages[0].content;

    expect(searchCalls).toBe(1);
    expect(result.providerIds).toContain("user-memory");
    expect(text).toContain("Relevant memory");
    expect(text).toContain("Andie project context should be available");
    expect(text).toContain("entity context: Andie");
  });
});
