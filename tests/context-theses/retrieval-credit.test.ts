import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Injection = { id: string; objectId: string; path: string; chars: number };
type Usage = { mentionedIds?: string[]; inspectedObjectIds?: string[]; checkpointObjectIds?: string[]; modifiedPaths?: string[]; verificationPassed?: boolean; supersededIds?: string[] };
type Credit = { byId: Record<string, number>; usefulChars: number; injectedChars: number; utilization: number; signals: Record<string, string[]> };

const injections: Injection[] = [
  { id: "cache", objectId: "ctx-cache", path: "src/cache.ts", chars: 200 },
  { id: "caller", objectId: "ctx-caller", path: "src/agent.ts", chars: 150 },
  { id: "noise", objectId: "ctx-noise", path: "docs/theme.md", chars: 300 },
];

async function credit(usage: Usage): Promise<Credit> {
  const api = await loadThesisModule("retrieval-credit");
  const fn = thesisFunction<(injections: Injection[], usage: Usage) => Credit>(api, "assignRetrievalCredit");
  return fn(injections, usage);
}

describe("Context thesis: retrieval credit assignment and adaptive budgets", () => {
  test("credits evidence mentioned by id", async () => {
    expect((await credit({ mentionedIds: ["cache"] })).byId.cache).toBeGreaterThan(0);
  });

  test("credits bounded exact reinspection", async () => {
    expect((await credit({ inspectedObjectIds: ["ctx-caller"] })).byId.caller).toBeGreaterThan(0);
  });

  test("credits evidence retained in a validated checkpoint", async () => {
    expect((await credit({ checkpointObjectIds: ["ctx-cache"] })).signals.cache).toContain("checkpointed");
  });

  test("credits evidence associated with a modified file and passing verification", async () => {
    const result = await credit({ modifiedPaths: ["src/cache.ts"], verificationPassed: true });
    expect(result.byId.cache).toBeGreaterThan(result.byId.noise);
    expect(result.signals.cache).toContain("verified_change");
  });

  test("does not reward injected but unused evidence", async () => {
    const result = await credit({ mentionedIds: ["cache"] });
    expect(result.byId.noise).toBe(0);
    expect(result.usefulChars).toBe(200);
  });

  test("penalizes superseded evidence", async () => {
    const result = await credit({ mentionedIds: ["noise"], supersededIds: ["noise"] });
    expect(result.byId.noise).toBeLessThanOrEqual(0);
  });

  test("reports useful-token utilization", async () => {
    const result = await credit({ mentionedIds: ["cache", "caller"] });
    expect(result.injectedChars).toBe(650);
    expect(result.usefulChars).toBe(350);
    expect(result.utilization).toBeCloseTo(350 / 650, 5);
  });

  test("does not leak repository content into telemetry", async () => {
    const result = await credit({ mentionedIds: ["cache"] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("function");
    expect(serialized).not.toContain("source code");
  });

  test("adapts packet count down after sustained low utilization", async () => {
    const api = await loadThesisModule("retrieval-credit");
    const adapt = thesisFunction<(history: number[], current: { maxPackets: number; maxChars: number }) => { maxPackets: number; maxChars: number }>(api, "adaptRetrievalBudget");
    expect(adapt([.05, .1, .08, .12], { maxPackets: 8, maxChars: 4_000 })).toEqual({ maxPackets: 6, maxChars: 3_000 });
  });

  test("adapts cautiously upward after high utilization and missed gold evidence", async () => {
    const api = await loadThesisModule("retrieval-credit");
    const adapt = thesisFunction<(history: number[], current: Record<string, number>, options?: Record<string, unknown>) => Record<string, number>>(api, "adaptRetrievalBudget");
    const next = adapt([.9, .95, .88], { maxPackets: 4, maxChars: 2_000 }, { missedRequiredEvidence: true });
    expect(next.maxPackets).toBe(5);
    expect(next.maxChars).toBeGreaterThan(2_000);
  });
});
