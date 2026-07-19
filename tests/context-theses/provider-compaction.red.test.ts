import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Capabilities = { serverCompaction: boolean; selectiveToolClearing: boolean; promptCaching: boolean; opaqueCompaction: boolean };
type State = { contextPercent: number; hasValidatedCheckpoint: boolean; hasObjectManifest: boolean; unresolvedFailures: number; providerCompacted?: boolean };
type Decision = { strategy: "none" | "keylime-mask" | "keylime-fold" | "provider-compact" | "provider-clear-tools"; requireCheckpoint: boolean; requireManifest: boolean; reasons: string[] };

async function decide(provider: Capabilities, state: State): Promise<Decision> {
  const api = await loadThesisModule("provider-compaction-policy");
  const fn = thesisFunction<(provider: Capabilities, state: State) => Decision>(api, "chooseCompactionStrategy");
  return fn(provider, state);
}

describe("RED thesis: provider-native compaction coordination", () => {
  const state: State = { contextPercent: 88, hasValidatedCheckpoint: true, hasObjectManifest: true, unresolvedFailures: 1 };

  test("uses deterministic masking before opaque compaction", async () => {
    const result = await decide({ serverCompaction: true, selectiveToolClearing: true, promptCaching: true, opaqueCompaction: true }, { ...state, contextPercent: 68 });
    expect(result.strategy).toBe("keylime-mask");
  });

  test("permits provider compaction only with a portable checkpoint and manifest", async () => {
    const result = await decide({ serverCompaction: true, selectiveToolClearing: false, promptCaching: true, opaqueCompaction: false }, state);
    expect(result.strategy).toBe("provider-compact");
    expect(result.requireCheckpoint).toBe(true);
    expect(result.requireManifest).toBe(true);
  });

  test("rejects provider compaction without a validated checkpoint", async () => {
    const result = await decide({ serverCompaction: true, selectiveToolClearing: false, promptCaching: true, opaqueCompaction: false }, { ...state, hasValidatedCheckpoint: false });
    expect(result.strategy).not.toBe("provider-compact");
  });

  test("rejects provider compaction without a recoverable object manifest", async () => {
    const result = await decide({ serverCompaction: true, selectiveToolClearing: false, promptCaching: true, opaqueCompaction: false }, { ...state, hasObjectManifest: false });
    expect(result.strategy).not.toBe("provider-compact");
  });

  test("does not stack provider compaction after provider compaction already occurred", async () => {
    const result = await decide({ serverCompaction: true, selectiveToolClearing: true, promptCaching: true, opaqueCompaction: false }, { ...state, providerCompacted: true });
    expect(result.strategy).not.toBe("provider-compact");
  });

  test("prefers selective stale tool clearing when unresolved failures are protected", async () => {
    const result = await decide({ serverCompaction: true, selectiveToolClearing: true, promptCaching: true, opaqueCompaction: false }, { ...state, contextPercent: 78 });
    expect(result.strategy).toBe("provider-clear-tools");
    expect(result.reasons.join(" ")).toContain("protect unresolved failures");
  });

  test("falls back to Keylime folding when native capabilities are absent", async () => {
    expect((await decide({ serverCompaction: false, selectiveToolClearing: false, promptCaching: false, opaqueCompaction: false }, state)).strategy).toBe("keylime-fold");
  });

  test("does nothing under low pressure", async () => {
    expect((await decide({ serverCompaction: true, selectiveToolClearing: true, promptCaching: true, opaqueCompaction: false }, { ...state, contextPercent: 30 })).strategy).toBe("none");
  });

  test("treats prompt caching as complementary rather than context reduction", async () => {
    const withCache = await decide({ serverCompaction: false, selectiveToolClearing: false, promptCaching: true, opaqueCompaction: false }, state);
    const withoutCache = await decide({ serverCompaction: false, selectiveToolClearing: false, promptCaching: false, opaqueCompaction: false }, state);
    expect(withCache.strategy).toBe(withoutCache.strategy);
  });
});
