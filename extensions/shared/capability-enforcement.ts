export type CapabilityLeaseEnforcementMode = "opt-in" | "required-mutations" | "required-all";

export function capabilityLeaseEnforcementMode(value = process.env.KEYLIME_CAPABILITY_LEASE_MODE): CapabilityLeaseEnforcementMode {
  if (value === "required-mutations" || value === "required-all") return value;
  return "opt-in";
}

export function capabilityLeaseRequirement(mode: CapabilityLeaseEnforcementMode, action: { mutates: boolean; leaseId?: unknown }): { required: boolean; blockReason?: string } {
  const hasLease = typeof action.leaseId === "string" && action.leaseId.length > 0;
  const required = mode === "required-all" || (mode === "required-mutations" && action.mutates);
  if (required && !hasLease) return { required: true, blockReason: `capability lease required by ${mode} policy` };
  return { required, blockReason: undefined };
}
