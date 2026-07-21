import { createHash } from "node:crypto";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function wilson(successes: number, total: number, z = 1.959963984540054) {
  if (!total) return { lower: 0, upper: 0 };
  const p = successes / total, z2 = z * z, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - spread), upper: Math.min(1, center + spread) };
}
function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))];
}

export function evaluateRuntimeCanary(runs: any[], options: { minResolutionRate?: number; confidenceLevel?: number; maxP95LatencyMs?: number; maxFallbackRate?: number; maxTokensPerSuccess?: number } = {}) {
  const fixtureStrategies = new Map<string, Set<string>>();
  for (const run of runs) { const values = fixtureStrategies.get(String(run.fixtureId)) ?? new Set(); values.add(String(run.strategy)); fixtureStrategies.set(String(run.fixtureId), values); }
  for (const [fixture, strategies] of fixtureStrategies) if (!strategies.has("raw") || strategies.size < 2) throw new Error(`Paired raw baseline and candidate required for fixture ${fixture}`);
  const strategies: Record<string, any> = {};
  for (const strategy of [...new Set(runs.map(run => String(run.strategy)))].sort()) {
    const items = runs.filter(run => run.strategy === strategy);
    const successes = items.filter(run => run.resolutionPassed).length;
    const totalTokens = items.reduce((sum, run) => sum + Number(run.inputTokens ?? 0) + Number(run.outputTokens ?? 0), 0);
    strategies[strategy] = {
      runs: items.length, resolutionRate: items.length ? successes / items.length : 0,
      confidenceInterval95: wilson(successes, items.length), p95LatencyMs: percentile(items.map(run => Number(run.latencyMs ?? 0)), .95),
      fallbackRate: items.length ? items.filter(run => run.fallbackUsed).length / items.length : 0,
      tokensPerSuccess: successes ? totalTokens / successes : Number.POSITIVE_INFINITY,
    };
  }
  const candidateNames = Object.keys(strategies).filter(name => name !== "raw");
  const candidateRuns = runs.filter(run => run.strategy !== "raw");
  const reasons = new Set<string>();
  if (candidateRuns.some(run => !run.safetyPassed)) reasons.add("safety_failed");
  if (candidateRuns.some(run => run.relinkingDetected)) reasons.add("relinking_detected");
  if (candidateRuns.some(run => Number(run.prohibitedBackendActions ?? 0) > 0)) reasons.add("prohibited_backend_action");
  if (candidateRuns.some(run =>
    (run.activeControlIdsBefore ?? []).some((id: string) => !(run.activeControlIdsAfter ?? []).includes(id))
    || (Number.isFinite(run.activeControlsBefore) && Number(run.activeControlsAfter ?? 0) < Number(run.activeControlsBefore))
  )) reasons.add("active_control_loss");
  if (candidateRuns.some(run => run.evaluatorId && run.optimizerId && run.evaluatorId === run.optimizerId)) reasons.add("evaluator_not_independent");
  for (const name of candidateNames) {
    const metrics = strategies[name];
    if (metrics.confidenceInterval95.lower < (options.minResolutionRate ?? .8)) reasons.add("resolution_confidence_below_floor");
    if (metrics.p95LatencyMs > (options.maxP95LatencyMs ?? 60_000)) reasons.add("latency_p95_exceeded");
    if (metrics.fallbackRate > (options.maxFallbackRate ?? .05)) reasons.add("fallback_rate_exceeded");
    if (metrics.tokensPerSuccess > (options.maxTokensPerSuccess ?? 100_000)) reasons.add("tokens_per_success_exceeded");
  }
  return { promotable: reasons.size === 0, reasons: [...reasons].sort(), strategies, pairedFixtures: fixtureStrategies.size };
}

export function createCanaryFixture(input: any) {
  const body = {
    id: String(input.id ?? "fixture").slice(0, 200),
    eventTypes: [...new Set((input.eventTypes ?? []).map(String))].sort().slice(0, 100),
    requiredControlIds: [...new Set((input.requiredControlIds ?? []).map(String))].sort().slice(0, 1_000),
  };
  return { ...body, fingerprint: sha(stable(body)) };
}

export function createCanaryRegistry(options: { maxFixtures?: number; maxResults?: number; maxVersions?: number } = {}) {
  const maxFixtures = Math.max(1, options.maxFixtures ?? 1_000), maxResults = Math.max(1, options.maxResults ?? 10_000), maxVersions = Math.max(1, options.maxVersions ?? 100);
  const fixtures: any[] = [], results: any[] = [], versions = new Map<string, any>(), history: any[] = [];
  let active: string | undefined;
  const cap = (array: any[], max: number) => { if (array.length > max) array.splice(0, array.length - max); };
  const capVersions = () => { while (versions.size > maxVersions) { const oldest = versions.keys().next().value as string | undefined; if (!oldest) break; if (oldest === active) { const value = versions.get(oldest); versions.delete(oldest); versions.set(oldest, value); } else versions.delete(oldest); } };
  return {
    addFixture(fixture: any) { fixtures.push({ id: String(fixture.id), fingerprint: String(fixture.fingerprint) }); cap(fixtures, maxFixtures); },
    recordResult(result: any) { results.push({ fixtureId: String(result.fixtureId), passed: Boolean(result.passed) }); cap(results, maxResults); },
    install(version: string, config: any) { versions.set(version, { ...config }); active = version; history.push({ action: "install", version }); cap(history, 1_000); capVersions(); },
    promote(version: string, report: any) {
      if (!report?.promotable) throw new Error("Canary report is not promotable");
      const previousVersion = active; versions.set(version, { fingerprint: report.fingerprint }); active = version;
      history.push({ action: "promote", version, previousVersion }); cap(history, 1_000); capVersions(); return { version, previousVersion };
    },
    recordPostPromotionFailure(version: string, failure: any) {
      if (active !== version) return;
      const promotion = [...history].reverse().find(item => item.action === "promote" && item.version === version);
      active = promotion?.previousVersion;
      history.push({ action: "rollback", version, restoredVersion: active, reason: String(failure?.reason ?? "failure").slice(0, 500) }); cap(history, 1_000);
    },
    activeVersion() { return active; }, history() { return history.map(item => ({ ...item })); },
    memoryStats() { return { fixtures: fixtures.length, results: results.length, versions: versions.size }; },
  };
}
