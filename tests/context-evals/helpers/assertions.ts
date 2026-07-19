import type { ContextEvalMetrics } from "./metrics";
import type { ContextEvalFixture } from "./trajectory";

export function assertContextReleaseGate(fixture: ContextEvalFixture, metrics: ContextEvalMetrics): void {
  const factRecall = metrics.requiredFactsTotal > 0 ? metrics.requiredFactsRetained / metrics.requiredFactsTotal : 1;
  if (factRecall < fixture.thresholds.minFactRecall) {
    throw new Error(`${fixture.id}: required fact recall ${factRecall.toFixed(3)} is below ${fixture.thresholds.minFactRecall.toFixed(3)}`);
  }
  if (metrics.trajectoryChars > fixture.thresholds.maxTrajectoryChars) {
    throw new Error(`${fixture.id}: trajectory character budget exceeded (${metrics.trajectoryChars} > ${fixture.thresholds.maxTrajectoryChars})`);
  }
  if (metrics.unrecoverableRemovedChars > fixture.thresholds.maxUnrecoverableRemovedChars) {
    throw new Error(`${fixture.id}: unrecoverable removed characters exceeded budget`);
  }
  if (fixture.thresholds.minReductionRate !== undefined && metrics.reductionRate < fixture.thresholds.minReductionRate) {
    throw new Error(`${fixture.id}: reduction rate is below category floor`);
  }
  if ((fixture.thresholds.requireSafety ?? true) && !metrics.safetyInvariantPass) {
    throw new Error(`${fixture.id}: safety invariant failed`);
  }
  if (metrics.nextActionMatch === false) throw new Error(`${fixture.id}: next action mismatch`);
}
