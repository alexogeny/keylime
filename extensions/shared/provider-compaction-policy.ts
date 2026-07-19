export type ProviderContextCapabilities = { serverCompaction: boolean; selectiveToolClearing: boolean; promptCaching: boolean; opaqueCompaction: boolean };
export type ProviderContextState = { contextPercent: number; hasValidatedCheckpoint: boolean; hasObjectManifest: boolean; unresolvedFailures: number; providerCompacted?: boolean };
export type CompactionStrategyDecision = { strategy: "none" | "keylime-mask" | "keylime-fold" | "provider-compact" | "provider-clear-tools"; requireCheckpoint: boolean; requireManifest: boolean; reasons: string[] };

export function chooseCompactionStrategy(provider: ProviderContextCapabilities, state: ProviderContextState): CompactionStrategyDecision {
  const base = { requireCheckpoint: false, requireManifest: false, reasons: [] as string[] };
  if (state.contextPercent < 65) return { strategy: "none", ...base };
  if (state.contextPercent < 75) return { strategy: "keylime-mask", ...base, reasons: ["prefer deterministic masking before compaction"] };
  if (provider.selectiveToolClearing && state.contextPercent < 85 && !state.providerCompacted) {
    return { strategy: "provider-clear-tools", ...base, reasons: state.unresolvedFailures ? ["protect unresolved failures while clearing stale tools"] : ["clear stale tool observations"] };
  }
  if (provider.serverCompaction && !provider.opaqueCompaction && !state.providerCompacted && state.hasValidatedCheckpoint && state.hasObjectManifest) {
    return { strategy: "provider-compact", requireCheckpoint: true, requireManifest: true, reasons: ["portable checkpoint and manifest available"] };
  }
  return { strategy: "keylime-fold", requireCheckpoint: true, requireManifest: true, reasons: ["native compaction unavailable or unsafe"] };
}
