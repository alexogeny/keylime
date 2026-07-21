import { describe, expect, test } from "bun:test";
import { buildFooterRight, buildSignalParts, INTENT_PERSONAS, memoryPersona } from "../extensions/signal-footer";
import * as signalFooter from "../extensions/signal-footer";

describe("signal footer formatting", () => {
  test("shows context pressure first and summarizes cache reuse intelligibly", () => {
    const statuses = new Map([
      ["memory-manager", "coding:core+repo+coding+project+safety+memory-lite"],
      ["cache-guard", "cache:98% (88.6M↩/90.4Min)"],
      ["context-health", "[███████░░░] 73% 146k/200k"],
    ]);
    expect(buildSignalParts(statuses)).toEqual([
      "ctx:73% pressure (146k/200k)",
      "cache:98% reused",
      "persona:Builder",
    ]);
  });

  test("maps verbose memory capability routes to compact personas", () => {
    expect(memoryPersona("review:readonly+repo+safety+memory-lite")).toBe("Sentinel");
    expect(memoryPersona("coding:core+repo+coding+project+safety+memory-lite")).toBe("Builder");
    expect(memoryPersona("research:research+fetch+memory-lite")).toBe("Scout");
    expect(memoryPersona("personal:personal+memory-lite")).toBe("Concierge");
    expect(memoryPersona("memory:memory+memory-lite")).toBe("Archivist");
    expect(memoryPersona("docs:readonly+documents+writing")).toBe("Scribe");
    expect(memoryPersona("unknown:core")).toBe("Generalist");
    expect(Object.keys(INTENT_PERSONAS).sort()).toEqual([
      "chat", "coding", "debugging", "linux_ops", "memory", "personal", "planning", "profiling", "project", "python_engineering", "refactor", "research", "review", "running_biomechanics", "running_shoes", "rust_shell_emulator", "rust_systems", "ui_design",
    ].sort());
  });

  test("separates current-turn traffic and cache reuse from cumulative branch totals", () => {
    const totals = (signalFooter as any).createTokenTotalsAccumulator([{ type: "message", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 30 } } }]);
    expect(totals.value()).toEqual({
      currentTurn: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 },
      branch: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 },
    });
    totals.record({ role: "assistant", usage: { input: 5, output: 1, cacheRead: 20, cacheWrite: 3 } });
    totals.record({ role: "user", content: "ignored" });
    expect(totals.value()).toEqual({
      currentTurn: { input: 5, output: 1, cacheRead: 20, cacheWrite: 3 },
      branch: { input: 15, output: 3, cacheRead: 50, cacheWrite: 3 },
    });
  });

  test("records completed assistant usage and requests a live footer render", async () => {
    const handlers: Record<string, any> = {};
    let footerFactory: any;
    let renderRequests = 0;
    signalFooter.default({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerCommand: () => {},
      getThinkingLevel: () => "high",
    } as any);
    const ctx = {
      hasUI: true,
      model: { id: "test-model" },
      sessionManager: { getBranch: () => [] },
      ui: { setFooter: (factory: any) => { footerFactory = factory; } },
    };

    await handlers.session_start({}, ctx);
    const footer = footerFactory(
      { requestRender: () => { renderRequests += 1; } },
      { fg: (_style: string, text: string) => text },
      {
        getExtensionStatuses: () => new Map(),
        getGitBranch: () => undefined,
        onBranchChange: () => () => {},
      },
    );
    expect(footer.render(120)[0]).toContain("turn in:0 cache:0 out:0");
    expect(footer.render(120)[0]).toContain("branch in:0 out:0");

    await handlers.message_end({ message: { role: "assistant", usage: { input: 12, output: 3, cacheRead: 40 } } }, ctx);

    expect(renderRequests).toBe(1);
    expect(footer.render(120)[0]).toContain("turn in:12 cache:40 out:3");
    expect(footer.render(120)[0]).toContain("branch in:12 out:3");
  });

  test("shows thinking level beside the model and git branch", () => {
    expect(buildFooterRight("claude-opus-4-6", "main", "high")).toBe("claude-opus-4-6 · think:high (main)");
    expect(buildFooterRight("gpt-5.6-terra", undefined, "off")).toBe("gpt-5.6-terra · think:off");
  });

  test("does not duplicate labels and keeps unavailable pressure visible", () => {
    const statuses = new Map([
      ["context-health", "ctx: —"],
      ["cache-guard", "cache: —"],
    ]);
    expect(buildSignalParts(statuses)).toEqual(["ctx:—", "cache:—"]);
  });
});
