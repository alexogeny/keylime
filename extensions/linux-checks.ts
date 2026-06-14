import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commandAvailable, runCommand, textResult } from "./shared/linux-safety";

const CHECKS: Record<string, { command: string; args: string[]; optional?: boolean }[]> = {
  health: [
    { command: "systemctl", args: ["--failed", "--no-pager"] },
    { command: "df", args: ["-h"] },
    { command: "journalctl", args: ["-p", "warning", "-n", "80", "--no-pager"] },
  ],
  packages: [
    { command: "apt-get", args: ["check"], optional: true },
    { command: "pacman", args: ["-Qk"], optional: true },
  ],
  network: [
    { command: "ip", args: ["addr", "show"] },
    { command: "ip", args: ["route", "show"] },
  ],
  gpu: [
    { command: "lspci", args: [] },
    { command: "nvidia-smi", args: [], optional: true },
  ],
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "run_system_check", label: "Run System Check", description: "Run a predefined bounded Linux health check suite.", promptGuidelines: ["Report exactly which checks were run.", "Use predefined suites rather than shell strings.", "Output is compact and actionable."], parameters: Type.Object({ suite: Type.Optional(Type.Union([Type.Literal("health"), Type.Literal("packages"), Type.Literal("network"), Type.Literal("gpu")])) }), async execute(_id: string, params: any) {
    const suite = params.suite ?? "health"; const checks = CHECKS[suite]; const parts: string[] = [];
    for (const check of checks) {
      if (check.optional && !(await commandAvailable(check.command))) continue;
      try { const r = await runCommand(check, { timeoutMs: 30_000 }); parts.push(`✓ ${check.command} ${check.args.join(" ")}\n${r.stdout || r.stderr}`.trim()); }
      catch (e: any) { parts.push(`✗ ${check.command} ${check.args.join(" ")}\n${e.stdout ?? e.stderr ?? e.message}`.trim()); }
    }
    return textResult(parts.join("\n\n"), { suite, commands: checks.map(c => [c.command, ...c.args].join(" ")) });
  }});
}
