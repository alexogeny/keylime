import { describe, expect, test } from "bun:test";

const routingModule = new URL("../../extensions/shared/agent-execution-profile.ts", import.meta.url).href;

async function productionRouter(): Promise<any> {
  return import(routingModule);
}

describe("RED: model effort and execution mode are routed by task requirements", () => {
  test("structured extraction uses a bounded efficient reasoning-off profile", async () => {
    const { selectAgentExecutionProfile } = await productionRouter();
    const profile = selectAgentExecutionProfile({
      taskKind: "structured_extraction",
      ambiguity: 0,
      risk: "low",
      contextPressure: .8,
      requiresCreativity: false,
    });

    expect(profile.execution).toBe("model");
    expect(profile.modelTier).toBe("efficient");
    expect(profile.reasoning).toBe("off");
    expect(profile.maxOutputTokens).toBeLessThanOrEqual(4_096);
    expect(profile.timeoutMs).toBeLessThanOrEqual(60_000);
  });

  test("deterministic schema and safety validation never consumes model tokens", async () => {
    const { selectAgentExecutionProfile } = await productionRouter();
    const profile = selectAgentExecutionProfile({
      taskKind: "deterministic_validation",
      ambiguity: 0,
      risk: "high",
      contextPressure: .9,
      requiresCreativity: false,
    });

    expect(profile.execution).toBe("local_code");
    expect(profile.modelTier).toBe("none");
    expect(profile.maxOutputTokens).toBe(0);
  });

  test("ambiguous cross-module debugging can select a stronger reasoning profile", async () => {
    const { selectAgentExecutionProfile } = await productionRouter();
    const profile = selectAgentExecutionProfile({
      taskKind: "cross_module_debugging",
      ambiguity: .95,
      risk: "medium",
      contextPressure: .4,
      requiresCreativity: true,
    });

    expect(profile.execution).toBe("model");
    expect(profile.modelTier).toBe("capable");
    expect(["medium", "high"]).toContain(profile.reasoning);
  });

  test("high context pressure cannot silently increase output or latency budgets", async () => {
    const { selectAgentExecutionProfile } = await productionRouter();
    const lowPressure = selectAgentExecutionProfile({
      taskKind: "structured_extraction", ambiguity: .1, risk: "low", contextPressure: .2, requiresCreativity: false,
    });
    const highPressure = selectAgentExecutionProfile({
      taskKind: "structured_extraction", ambiguity: .1, risk: "low", contextPressure: .95, requiresCreativity: false,
    });

    expect(highPressure.maxOutputTokens).toBeLessThanOrEqual(lowPressure.maxOutputTokens);
    expect(highPressure.timeoutMs).toBeLessThanOrEqual(lowPressure.timeoutMs);
  });

  test("routing is deterministic and explains its budget decision", async () => {
    const { selectAgentExecutionProfile } = await productionRouter();
    const request = {
      taskKind: "structured_extraction", ambiguity: .1, risk: "low", contextPressure: .7, requiresCreativity: false,
    };
    const first = selectAgentExecutionProfile(request);
    const second = selectAgentExecutionProfile(request);

    expect(first).toEqual(second);
    expect(first.rationale).toEqual(expect.arrayContaining([
      expect.stringContaining("structured_extraction"),
      expect.stringContaining("bounded"),
    ]));
  });
});
