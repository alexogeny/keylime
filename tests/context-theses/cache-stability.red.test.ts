import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Segment = { id: string; stability: "static" | "session" | "turn"; content: string; toolSchemas?: string[] };
type Assembly = { text: string; orderedSegmentIds: string[]; stablePrefix: string; volatileSuffix: string; fingerprint: string };

const segments: Segment[] = [
  { id: "turn-evidence", stability: "turn", content: "latest failure" },
  { id: "base", stability: "static", content: "system rules" },
  { id: "session", stability: "session", content: "repository identity" },
  { id: "tools", stability: "static", content: "tool catalog", toolSchemas: ["zeta", "alpha"] },
];

async function assemble(input = segments, options: Record<string, unknown> = {}): Promise<Assembly> {
  const api = await loadThesisModule("cache-stable-context");
  const fn = thesisFunction<(segments: Segment[], options: Record<string, unknown>) => Assembly>(api, "assembleCacheStableContext");
  return fn(input, options);
}

describe("RED thesis: cache-stable prompt assembly", () => {
  test("orders static then session then turn context", async () => {
    expect((await assemble()).orderedSegmentIds).toEqual(["base", "tools", "session", "turn-evidence"]);
  });

  test("sorts stable tool schemas deterministically", async () => {
    const result = await assemble();
    expect(result.stablePrefix.indexOf("alpha")).toBeLessThan(result.stablePrefix.indexOf("zeta"));
  });

  test("keeps per-turn evidence out of the stable prefix", async () => {
    const result = await assemble();
    expect(result.stablePrefix).not.toContain("latest failure");
    expect(result.volatileSuffix).toContain("latest failure");
  });

  test("produces the same stable prefix when only volatile evidence changes", async () => {
    const first = await assemble();
    const changed = await assemble(segments.map(segment => segment.id === "turn-evidence" ? { ...segment, content: "different failure" } : segment));
    expect(changed.stablePrefix).toBe(first.stablePrefix);
  });

  test("produces the same fingerprint under input reordering", async () => {
    expect((await assemble()).fingerprint).toBe((await assemble([...segments].reverse())).fingerprint);
  });

  test("does not inject timestamps or random ids into stable content", async () => {
    const result = await assemble(segments, { now: 1_800_000_000_000, requestId: "random-123" });
    expect(result.stablePrefix).not.toContain("1800000000000");
    expect(result.stablePrefix).not.toContain("random-123");
  });

  test("uses stable tool masks without rewriting schemas", async () => {
    const api = await loadThesisModule("cache-stable-context");
    const mask = thesisFunction<(schemas: string[], active: string[]) => { schemas: string[]; mask: Record<string, boolean> }>(api, "maskToolAvailability");
    const first = mask(["read", "write", "fetch"], ["read"]);
    const second = mask(["read", "write", "fetch"], ["fetch"]);
    expect(second.schemas).toEqual(first.schemas);
    expect(first.mask).toEqual({ read: true, write: false, fetch: false });
    expect(second.mask).toEqual({ read: false, write: false, fetch: true });
  });

  test("attributes the segment responsible for cache invalidation", async () => {
    const api = await loadThesisModule("cache-stable-context");
    const diff = thesisFunction<(before: Assembly, after: Assembly) => { invalidatedBy: string[]; reusablePrefixChars: number }>(api, "explainCacheInvalidation");
    const before = await assemble();
    const after = await assemble(segments.map(segment => segment.id === "session" ? { ...segment, content: "new repository" } : segment));
    expect(diff(before, after).invalidatedBy).toEqual(["session"]);
    expect(diff(before, after).reusablePrefixChars).toBeGreaterThan(0);
  });

  test("distinguishes cache savings from active-context reduction", async () => {
    const result = await assemble();
    expect(result.text.length).toBe(result.stablePrefix.length + result.volatileSuffix.length);
    expect(result.stablePrefix.length).toBeGreaterThan(0);
  });
});
