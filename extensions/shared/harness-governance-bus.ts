type GovernanceRuntime = {
  repositoryFingerprint: string;
  buildImpact(paths: string[]): Promise<any>;
  snapshot(): any;
};

let active: { cwd: string; runtime: GovernanceRuntime } | undefined;

export function publishHarnessGovernanceRuntime(cwd: string, runtime: GovernanceRuntime): void {
  active = { cwd, runtime };
}

export function readHarnessGovernanceRuntime(cwd: string): GovernanceRuntime | undefined {
  return active?.cwd === cwd ? active.runtime : undefined;
}

export function clearHarnessGovernanceRuntime(runtime?: GovernanceRuntime): void {
  if (!runtime || active?.runtime === runtime) active = undefined;
}
