import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Candidate = {
  id: string; path: string; startLine: number; endLine: number; text: string;
  lexical: number; semantic: number; graph: number; recency: number;
  symbols: string[]; objectId: string;
};
type Intent = { objective: string; symbols: string[]; paths: string[]; failure?: string; pendingStep?: string };
type Packet = { id: string; path: string; lines: string; reason: string; confidence: number; objectId: string; estimatedTokens: number };

const candidates: Candidate[] = [
  { id: "target", path: "src/cache.ts", startLine: 40, endLine: 55, text: "function invalidatePrefix(key: string)", lexical: .9, semantic: .9, graph: .8, recency: .5, symbols: ["invalidatePrefix"], objectId: "ctx-target" },
  { id: "caller", path: "src/agent.ts", startLine: 10, endLine: 20, text: "invalidatePrefix(sessionKey)", lexical: .5, semantic: .7, graph: 1, recency: .8, symbols: ["runAgent"], objectId: "ctx-caller" },
  { id: "duplicate", path: "src/cache.ts", startLine: 45, endLine: 60, text: "function invalidatePrefix(key: string)", lexical: .85, semantic: .9, graph: .7, recency: .4, symbols: ["invalidatePrefix"], objectId: "ctx-dup" },
  { id: "noise", path: "docs/theme.md", startLine: 1, endLine: 20, text: "theme colors", lexical: .1, semantic: .05, graph: 0, recency: 1, symbols: [], objectId: "ctx-noise" },
];

async function select(intent: Intent, input = candidates, budget = { maxTokens: 180, maxPackets: 3, maxFiles: 2 }): Promise<Packet[]> {
  const api = await loadThesisModule("evidence-packets");
  const fn = thesisFunction<(intent: Intent, candidates: Candidate[], budget: Record<string, number>) => Packet[]>(api, "selectEvidencePackets");
  return fn(intent, input, budget);
}

describe("RED thesis: intention-aware evidence packets", () => {
  const intent: Intent = { objective: "fix cache prefix invalidation", symbols: ["invalidatePrefix"], paths: ["src/cache.ts"], failure: "stale prefix reused", pendingStep: "inspect implementation and caller" };

  test("ranks direct objective and symbol evidence first", async () => {
    expect((await select(intent))[0].id).toBe("target");
  });

  test("uses graph-connected caller evidence", async () => {
    expect((await select(intent)).map(item => item.id)).toContain("caller");
  });

  test("excludes unrelated high-recency noise", async () => {
    expect((await select(intent)).map(item => item.id)).not.toContain("noise");
  });

  test("deduplicates overlapping regions", async () => {
    const ids = (await select(intent)).map(item => item.id);
    expect(ids.filter(id => id === "target" || id === "duplicate")).toHaveLength(1);
  });

  test("obeys token packet and file budgets", async () => {
    const packets = await select(intent, candidates, { maxTokens: 80, maxPackets: 1, maxFiles: 1 });
    expect(packets.length).toBeLessThanOrEqual(1);
    expect(packets.reduce((sum, item) => sum + item.estimatedTokens, 0)).toBeLessThanOrEqual(80);
    expect(new Set(packets.map(item => item.path)).size).toBeLessThanOrEqual(1);
  });

  test("provides source anchors reasons confidence and recovery handles", async () => {
    for (const packet of await select(intent)) {
      expect(packet.path).toBeTruthy();
      expect(packet.lines).toMatch(/^\d+-\d+$/);
      expect(packet.reason.length).toBeGreaterThan(8);
      expect(packet.confidence).toBeGreaterThanOrEqual(0);
      expect(packet.confidence).toBeLessThanOrEqual(1);
      expect(packet.objectId).toMatch(/^ctx-/);
    }
  });

  test("changes selection when the active failure changes", async () => {
    const failureCandidate: Candidate = { ...candidates[3], id: "timeout", path: "src/network.ts", text: "TimeoutError retry budget", semantic: .95, lexical: .8, objectId: "ctx-timeout" };
    const packets = await select({ objective: "debug TimeoutError", symbols: [], paths: [], failure: "TimeoutError" }, [...candidates, failureCandidate]);
    expect(packets[0].id).toBe("timeout");
  });

  test("is deterministic under candidate input reordering", async () => {
    expect(await select(intent, candidates)).toEqual(await select(intent, [...candidates].reverse()));
  });

  test("maintains full gold recall with precision above 0.66", async () => {
    const ids = new Set((await select(intent)).map(item => item.id));
    const gold = ["target", "caller"];
    expect(gold.every(id => ids.has(id))).toBe(true);
    expect(gold.filter(id => ids.has(id)).length / ids.size).toBeGreaterThanOrEqual(0.66);
  });
});
