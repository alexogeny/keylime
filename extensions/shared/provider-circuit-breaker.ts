export type ProviderFailureKind = "timeout" | "network" | "provider_unavailable" | "rate_limit" | "invalid_json" | "schema_validation";
export type CircuitState = "closed" | "open" | "half_open";
export type ProviderCircuitSnapshot = { state: CircuitState; consecutiveFailures: number; openUntil?: number; probeInFlight: boolean };

type Entry = ProviderCircuitSnapshot & { updatedAt: number };
const PROVIDER_FAILURES = new Set<ProviderFailureKind>(["timeout", "network", "provider_unavailable", "rate_limit"]);

export function createProviderCircuitBreaker(options: { failureThreshold?: number; cooldownMs?: number; maxKeys?: number } = {}) {
  const threshold = Math.max(1, options.failureThreshold ?? 3);
  const cooldownMs = Math.max(1, options.cooldownMs ?? 30_000);
  const maxKeys = Math.max(1, options.maxKeys ?? 100);
  const entries = new Map<string, Entry>();

  const entry = (key: string): Entry => entries.get(key) ?? {
    state: "closed", consecutiveFailures: 0, probeInFlight: false, updatedAt: Date.now(),
  };
  const save = (key: string, value: Entry): void => {
    value.updatedAt = Date.now();
    entries.set(key, value);
    if (entries.size <= maxKeys) return;
    const oldest = [...entries.entries()].filter(([candidate]) => candidate !== key).sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
    if (oldest) entries.delete(oldest);
  };

  return {
    allowRequest(key: string): boolean {
      const current = entry(key);
      if (current.state === "closed") return true;
      if (current.state === "half_open") return false;
      if ((current.openUntil ?? 0) > Date.now()) return false;
      save(key, { ...current, state: "half_open", probeInFlight: true });
      return true;
    },
    recordFailure(key: string, kind: ProviderFailureKind): void {
      if (!PROVIDER_FAILURES.has(kind)) return;
      const current = entry(key);
      const consecutiveFailures = current.consecutiveFailures + 1;
      const shouldOpen = current.state === "half_open" || consecutiveFailures >= threshold;
      save(key, shouldOpen
        ? { state: "open", consecutiveFailures, openUntil: Date.now() + cooldownMs, probeInFlight: false, updatedAt: Date.now() }
        : { ...current, consecutiveFailures });
    },
    recordSuccess(key: string): void {
      save(key, { state: "closed", consecutiveFailures: 0, probeInFlight: false, updatedAt: Date.now() });
    },
    snapshot(key: string): ProviderCircuitSnapshot {
      const { updatedAt: _updatedAt, ...snapshot } = entry(key);
      return snapshot;
    },
    memoryStats(): { keys: number; maxKeys: number } { return { keys: entries.size, maxKeys }; },
  };
}
