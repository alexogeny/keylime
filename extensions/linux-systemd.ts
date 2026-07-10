import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { consumeOperationPlan, createOperationPlan, denylistedSystemdUnit, operationTarget, registerLinuxTool, requireApproved, runCommand, sudoPrefix, textResult, validateOperand } from "./shared/linux-safety";

const guidelines = ["Use exact unit names.", "Inspect status/logs before restart/enable/disable.", "Critical networking, SSH, and display units are denied by default."];
const unitParam = Type.Object({ unit: Type.String({ description: "Exact systemd unit, e.g. nginx.service" }) });
function validateUnit(unit: string) { validateOperand(unit, "systemd unit"); if (!/^[A-Za-z0-9_.@:-]+\.(?:service|socket|timer|target|mount|path)$/.test(unit)) throw new Error("Use an exact systemd unit name with a supported suffix"); return unit; }
function ensureMutableUnit(unit: string) { const valid = validateUnit(unit); const reason = denylistedSystemdUnit(valid); if (reason) throw new Error(reason); return valid; }

export default function (pi: ExtensionAPI) {
  registerLinuxTool(pi, { name: "systemd_list_units", label: "Systemd List Units", description: "List systemd units with bounded output.", promptGuidelines: guidelines, parameters: Type.Object({ state: Type.Optional(Type.String()) }), async execute(_id: string, params: any) {
    const args = ["list-units", "--no-pager", "--plain", ...(params.state ? ["--state", validateOperand(params.state, "unit state")] : [])];
    const r = await runCommand({ command: "systemctl", args });
    return textResult(r.stdout, { state: params.state });
  }});
  registerLinuxTool(pi, { name: "systemd_status", label: "Systemd Status", description: "Inspect one systemd unit status.", promptGuidelines: guidelines, parameters: unitParam, async execute(_id: string, params: any) {
    const unit = validateUnit(params.unit); const r = await runCommand({ command: "systemctl", args: ["status", "--no-pager", "--lines", "80", "--", unit] });
    return textResult(r.stdout || r.stderr, { unit: params.unit });
  }});
  registerLinuxTool(pi, { name: "systemd_logs", label: "Systemd Logs", description: "Inspect bounded journal logs for one unit.", promptGuidelines: guidelines, parameters: Type.Object({ unit: Type.String(), since: Type.Optional(Type.String()), lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })) }), async execute(_id: string, params: any) {
    const unit = validateUnit(params.unit); const args = ["-u", unit, "--no-pager", "-n", String(params.lines ?? 120), ...(params.since ? ["--since", validateOperand(params.since, "since value")] : [])];
    const r = await runCommand({ command: "journalctl", args });
    return textResult(r.stdout || r.stderr, { unit: params.unit });
  }});
  registerLinuxTool(pi, { name: "systemd_plan_restart", label: "Systemd Plan Restart", description: "Validate that a unit restart is allowed and show the command.", promptGuidelines: guidelines, parameters: unitParam, async execute(_id: string, params: any) {
    const unit = ensureMutableUnit(params.unit); const plan = createOperationPlan("systemd-action", operationTarget({ action: "restart", unit })); return textResult(`Plan: sudo systemctl restart -- ${unit}`, { unit, action: "restart", plan_token: plan.planToken, expires_at: plan.expiresAt });
  }});
  registerLinuxTool(pi, { name: "systemd_plan_action", label: "Systemd Plan Action", description: "Plan restart, reload, enable, or disable for an exact non-critical unit.", promptGuidelines: guidelines, parameters: Type.Object({ unit: Type.String(), action: Type.Union([Type.Literal("restart"), Type.Literal("reload"), Type.Literal("enable"), Type.Literal("disable")]) }), async execute(_id: string, params: any) {
    const unit = ensureMutableUnit(params.unit); const plan = createOperationPlan("systemd-action", operationTarget({ action: params.action, unit }));
    return textResult(`Plan: sudo systemctl ${params.action} -- ${unit}`, { unit, action: params.action, plan_token: plan.planToken, expires_at: plan.expiresAt });
  }});
  registerLinuxTool(pi, { name: "systemd_list_timers", label: "Systemd List Timers", description: "List systemd timers and their next run times.", promptGuidelines: guidelines, parameters: Type.Object({ all: Type.Optional(Type.Boolean()) }), async execute(_id: string, params: any) {
    const r = await runCommand({ command: "systemctl", args: ["list-timers", "--no-pager", "--plain", ...(params.all ? ["--all"] : [])] }); return textResult(r.stdout || r.stderr);
  }});
  for (const action of ["restart", "reload", "enable", "disable"] as const) {
    registerLinuxTool(pi, { name: `systemd_${action}`, label: `Systemd ${action}`, description: `${action} a systemd unit after matching plan review and sudo approval.`, promptGuidelines: [...guidelines, "A matching, unexpired plan_token is required."], parameters: Type.Object({ unit: Type.String(), plan_token: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const unit = ensureMutableUnit(params.unit);
      consumeOperationPlan(params.plan_token, "systemd-action", operationTarget({ action, unit }));
      await requireApproved(ctx, `Review systemd ${action}`, `sudo systemctl ${action} -- ${unit}`);
      const spec = await sudoPrefix(ctx, { command: "systemctl", args: [action, "--", unit], sudo: true });
      const r = await runCommand(spec, { timeoutMs: 60_000 });
      return textResult([r.stdout, r.stderr].filter(Boolean).join("\n") || `systemctl ${action} completed`, { unit: params.unit, action });
    }});
  }
}
