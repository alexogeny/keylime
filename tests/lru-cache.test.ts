import { describe, expect, test } from "bun:test";
import { LruCache } from "../extensions/shared/lru-cache";

describe("LruCache", () => {
  test("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  test("coalesces concurrent loaders", async () => {
    const cache = new LruCache<string, number>({ maxEntries: 2 });
    let loads = 0;
    const load = async () => { loads++; await Promise.resolve(); return 42; };
    expect(await Promise.all([cache.getOrLoad("answer", load), cache.getOrLoad("answer", load)])).toEqual([42, 42]);
    expect(loads).toBe(1);
  });
});
