import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { denylistedSystemdUnit, requireApproved, runCommand, sudoPrefix, textResult } from "./shared/linux-safety";

const guidelines = ["Use exact unit names.", "Inspect status/logs before restart/enable/disable.", "Critical networking, SSH, and display units are denied by default."];
const unitParam = Type.Object({ unit: Type.String({ description: "Exact systemd unit, e.g. nginx.service" }) });
function ensureUnit(unit: string) { const reason = denylistedSystemdUnit(unit); if (reason) throw new Error(reason); }

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "systemd_list_units", label: "Systemd List Units", description: "List systemd units with bounded output.", promptGuidelines: guidelines, parameters: Type.Object({ state: Type.Optional(Type.String()) }), async execute(params: any) {
    const args = ["list-units", "--no-pager", "--plain", ...(params.state ? ["--state", params.state] : [])];
    const r = await runCommand({ command: "systemctl", args });
    return textResult(r.stdout, { state: params.state });
  }});
  pi.registerTool({ name: "systemd_status", label: "Systemd Status", description: "Inspect one systemd unit status.", promptGuidelines: guidelines, parameters: unitParam, async execute(params: any) {
    const r = await runCommand({ command: "systemctl", args: ["status", params.unit, "--no-pager", "--lines", "80"] });
    return textResult(r.stdout || r.stderr, { unit: params.unit });
  }});
  pi.registerTool({ name: "systemd_logs", label: "Systemd Logs", description: "Inspect bounded journal logs for one unit.", promptGuidelines: guidelines, parameters: Type.Object({ unit: Type.String(), since: Type.Optional(Type.String()), lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })) }), async execute(params: any) {
    const args = ["-u", params.unit, "--no-pager", "-n", String(params.lines ?? 120), ...(params.since ? ["--since", params.since] : [])];
    const r = await runCommand({ command: "journalctl", args });
    return textResult(r.stdout || r.stderr, { unit: params.unit });
  }});
  pi.registerTool({ name: "systemd_plan_restart", label: "Systemd Plan Restart", description: "Validate that a unit restart is allowed and show the command.", promptGuidelines: guidelines, parameters: unitParam, async execute(params: any) {
    ensureUnit(params.unit); return textResult(`Plan: sudo systemctl restart ${params.unit}`, { unit: params.unit });
  }});
  for (const action of ["restart", "enable", "disable"] as const) {
    pi.registerTool({ name: `systemd_${action}`, label: `Systemd ${action}`, description: `${action} a systemd unit after review and sudo approval.`, promptGuidelines: [...guidelines, `Run systemd_plan_restart before restart; inspect status first for ${action}.`], parameters: unitParam, async execute(params: any, ctx: any) {
      ensureUnit(params.unit);
      await requireApproved(ctx, `Review systemd ${action}`, `sudo systemctl ${action} ${params.unit}`);
      const spec = await sudoPrefix(ctx, { command: "systemctl", args: [action, params.unit], sudo: true });
      const r = await runCommand(spec, { timeoutMs: 60_000 });
      return textResult([r.stdout, r.stderr].filter(Boolean).join("\n") || `systemctl ${action} completed`, { unit: params.unit, action });
    }});
  }
}
