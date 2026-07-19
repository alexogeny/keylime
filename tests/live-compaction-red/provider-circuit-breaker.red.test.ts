import { describe, expect, test } from "bun:test";

const moduleUrl = new URL("../../extensions/shared/provider-circuit-breaker.ts", import.meta.url).href;
async function production(): Promise<any> { return import(moduleUrl); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("RED: degraded providers cannot repeatedly stall compaction", () => {
  test("opens after repeated timeout or network failures", async () => {
    const { createProviderCircuitBreaker } = await production();
    const breaker = createProviderCircuitBreaker({ failureThreshold: 3, cooldownMs: 50 });
    const key = "provider/model";
    breaker.recordFailure(key, "timeout");
    breaker.recordFailure(key, "network");
    expect(breaker.allowRequest(key)).toBe(true);
    breaker.recordFailure(key, "timeout");

    expect(breaker.allowRequest(key)).toBe(false);
    expect(breaker.snapshot(key)).toEqual(expect.objectContaining({ state: "open", consecutiveFailures: 3 }));
  });

  test("does not open for model-generated schema errors", async () => {
    const { createProviderCircuitBreaker } = await production();
    const breaker = createProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });
    const key = "provider/model";
    breaker.recordFailure(key, "invalid_json");
    breaker.recordFailure(key, "schema_validation");

    expect(breaker.allowRequest(key)).toBe(true);
    expect(breaker.snapshot(key).consecutiveFailures).toBe(0);
  });

  test("permits one half-open probe after cooldown and closes on success", async () => {
    const { createProviderCircuitBreaker } = await production();
    const breaker = createProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
    const key = "provider/model";
    breaker.recordFailure(key, "timeout");
    expect(breaker.allowRequest(key)).toBe(false);
    await sleep(30);

    expect(breaker.allowRequest(key)).toBe(true);
    expect(breaker.allowRequest(key)).toBe(false);
    expect(breaker.snapshot(key).state).toBe("half_open");
    breaker.recordSuccess(key);
    expect(breaker.snapshot(key).state).toBe("closed");
    expect(breaker.allowRequest(key)).toBe(true);
  });

  test("isolates health state by provider and model", async () => {
    const { createProviderCircuitBreaker } = await production();
    const breaker = createProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    breaker.recordFailure("provider-a/model-a", "network");

    expect(breaker.allowRequest("provider-a/model-a")).toBe(false);
    expect(breaker.allowRequest("provider-a/model-b")).toBe(true);
    expect(breaker.allowRequest("provider-b/model-a")).toBe(true);
  });
});
