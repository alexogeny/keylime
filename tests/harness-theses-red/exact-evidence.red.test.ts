import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { storeContextObject } from "../../extensions/context-object-store";
import {
  selectEvidencePackets,
  type EvidenceCandidate,
  type EvidenceIntent,
} from "../../extensions/shared/evidence-packets";

const intent: EvidenceIntent = {
  objective: "Fix validateOrder behavior",
  symbols: ["validateOrder"],
  paths: ["src/order.ts"],
  failure: "expected rejected order",
  pendingStep: "edit validateOrder and its tests",
};

function candidate(overrides: Partial<EvidenceCandidate> & { id: string; path: string; text: string }): EvidenceCandidate {
  return {
    startLine: 1,
    endLine: overrides.text.split("\n").length,
    lexical: .7,
    semantic: .7,
    graph: .5,
    recency: .5,
    symbols: ["validateOrder"],
    objectId: `object-${overrides.id}`,
    ...overrides,
  };
}

describe("RED: evidence selection preserves exact edit-time source", () => {
  test("evidence packets carry exact source text and a verifiable content hash", () => {
    const source = "export function validateOrder(order: Order) {\n  return order.total > 0;\n}";
    const packets = selectEvidencePackets(intent, [candidate({
      id: "exact-source",
      path: "src/order.ts",
      text: source,
      startLine: 40,
      endLine: 42,
    })], { maxTokens: 500, maxPackets: 2, maxFiles: 2 }) as any[];

    expect(packets[0].exactText).toBe(source);
    expect(packets[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a natural-language summary cannot outrank exact source for an edit action", () => {
    const candidates = [
      candidate({
        id: "summary",
        path: "src/order.ts",
        text: "The validator appears to reject orders under some conditions.",
        lexical: 1,
        semantic: 1,
        graph: 1,
        recency: 1,
        representation: "summary",
      } as any),
      candidate({
        id: "exact-source",
        path: "src/order.ts",
        text: "export function validateOrder(order: Order) { return order.total > 0; }",
        lexical: .45,
        semantic: .45,
        graph: .45,
        recency: .45,
        representation: "exact_source",
      } as any),
    ];

    const packets = selectEvidencePackets(intent, candidates, { maxTokens: 500, maxPackets: 1, maxFiles: 1 });
    expect(packets[0]?.id).toBe("exact-source");
  });

  test("semantically duplicate regions across different paths do not crowd out a relevant test", () => {
    const duplicateText = "function validateOrder(order) { return order.total > 0; }";
    const candidates = [
      candidate({ id: "implementation-copy-a", path: "src/a.ts", text: duplicateText, lexical: 1, semantic: 1, graph: 1 }),
      candidate({ id: "implementation-copy-b", path: "src/b.ts", text: duplicateText, lexical: 1, semantic: 1, graph: 1 }),
      candidate({
        id: "behavioral-test",
        path: "tests/order.test.ts",
        text: "test('negative totals are invalid', () => expect(validateOrder(invalid)).toBe(false));",
        lexical: .55,
        semantic: .55,
        graph: .55,
      }),
    ];

    const packets = selectEvidencePackets(intent, candidates, { maxTokens: 500, maxPackets: 2, maxFiles: 3 });
    expect(packets.map(packet => packet.id)).toContain("behavioral-test");
    expect(packets.filter(packet => packet.id.startsWith("implementation-copy"))).toHaveLength(1);
  });

  test("an oversized failing diagnostic is clipped with recovery metadata rather than dropped", () => {
    const diagnostic = `expected rejected order\n${"stack frame\n".repeat(500)}`;
    const packets = selectEvidencePackets(intent, [
      candidate({
        id: "critical-diagnostic",
        path: "tests/order.test.ts",
        text: diagnostic,
        lexical: 1,
        semantic: 1,
        graph: .8,
      }),
      candidate({ id: "routine-note", path: "notes.txt", text: "Fix order behavior", lexical: .7, semantic: .7 }),
    ], { maxTokens: 100, maxPackets: 2, maxFiles: 2 }) as any[];

    const packet = packets.find(item => item.id === "critical-diagnostic");
    expect(packet).toBeDefined();
    expect(packet.estimatedTokens).toBeLessThanOrEqual(100);
    expect(packet.truncated).toBe(true);
    expect(packet.objectId).toBe("object-critical-diagnostic");
  });

  test("selected evidence can hydrate byte-identical source from the real context-object store", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-exact-evidence-"));
    const source = "export function validateOrder(order: Order) {\n  return order.total > 0;\n}";
    try {
      const stored = await storeContextObject(cwd, {
        id: "exact-source-1",
        kind: "file_read",
        sourceTool: "inspect_lines",
        content: source,
        summary: "Exact validateOrder source",
        retention: "reconstructable",
      });
      const packets = selectEvidencePackets(intent, [candidate({
        id: "stored-source",
        path: "src/order.ts",
        text: source,
        objectId: stored.object.id,
      })], { maxTokens: 500, maxPackets: 1, maxFiles: 1 }) as any[];

      expect(packets[0].hydratedText).toBe(source);
      expect(packets[0].contentHash).toBe(stored.object.contentHash);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("edit evidence includes the relevant behavioral test as well as the implementation", () => {
    const packets = selectEvidencePackets(intent, [
      candidate({ id: "implementation", path: "src/order.ts", text: "function validateOrder() {}", lexical: 1, semantic: 1 }),
      candidate({ id: "test", path: "tests/order.test.ts", text: "expected rejected order", lexical: .6, semantic: .6 }),
      candidate({ id: "similar-implementation", path: "src/other.ts", text: "function validateOther() {}", lexical: .9, semantic: .9 }),
    ], { maxTokens: 500, maxPackets: 2, maxFiles: 3 });

    expect(packets.map(packet => packet.id)).toEqual(expect.arrayContaining(["implementation", "test"]));
  });
});
