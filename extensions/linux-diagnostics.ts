import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { commandAvailable, preview, registerLinuxTool, runCommand, textResult, validateOperand } from "./shared/linux-safety";

const guidelines = [
  "Read-only Linux diagnostics only; never mutate services, devices, containers, or kernel state.",
  "Keep output bounded and explain unavailable optional utilities.",
];

async function optionalCommand(command: string, args: string[], maxChars = 12000): Promise<string> {
  if (!(await commandAvailable(command))) return `$ ${command} ${args.join(" ")}\nUnavailable`;
  try {
    const result = await runCommand({ command, args }, { timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
    return `$ ${command} ${args.join(" ")}\n${preview(result.stdout || result.stderr || "No output", maxChars)}`;
  } catch (error: any) {
    return `$ ${command} ${args.join(" ")}\n${preview(error.stdout ?? error.stderr ?? error.message ?? String(error), maxChars)}`;
  }
}

export default function (pi: ExtensionAPI) {
  registerLinuxTool(pi, {
    name: "inspect_boot",
    label: "Inspect Boot",
    description: "Inspect current-boot warnings, boot timing, and slow units.",
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() {
      const parts = await Promise.all([
        optionalCommand("journalctl", ["-b", "-p", "warning", "-n", "120", "--no-pager"]),
        optionalCommand("systemd-analyze", ["time"]),
        optionalCommand("systemd-analyze", ["blame"]),
        optionalCommand("systemd-analyze", ["critical-chain"]),
      ]);
      return textResult(parts.join("\n\n"));
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_pressure",
    label: "Inspect Pressure",
    description: "Inspect load averages and Linux CPU, memory, and I/O pressure stall information.",
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() {
      const files = ["/proc/loadavg", "/proc/pressure/cpu", "/proc/pressure/memory", "/proc/pressure/io"];
      const parts: string[] = [];
      for (const file of files) {
        try { parts.push(`${file}\n${preview(await readFile(file, "utf8"), 4000)}`); }
        catch (error: any) { parts.push(`${file}\nUnavailable: ${error.message ?? error}`); }
      }
      return textResult(parts.join("\n\n"));
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_disk_health",
    label: "Inspect Disk Health",
    description: "Inspect SMART or NVMe health for one explicit block device without changing it.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ device: Type.String({ description: "Exact /dev device, for example /dev/nvme0 or /dev/sda" }) }),
    async execute(_id: string, params: any) {
      const device = validateOperand(params.device, "device");
      if (!/^\/dev\/[A-Za-z0-9._-]+$/.test(device)) throw new Error("Device must be one exact path directly under /dev");
      const specs = device.includes("nvme")
        ? [["nvme", ["smart-log", device]], ["smartctl", ["-a", "--", device]]] as const
        : [["smartctl", ["-a", "--", device]]] as const;
      const parts: string[] = [];
      for (const [command, args] of specs) parts.push(await optionalCommand(command, [...args]));
      return textResult(parts.join("\n\n"), { device });
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_open_deleted_files",
    label: "Inspect Open Deleted Files",
    description: "Find deleted files still held open by processes, a common hidden disk-usage cause.",
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() { return textResult(await optionalCommand("lsof", ["+L1", "-nP"], 20000)); },
  });

  registerLinuxTool(pi, {
    name: "inspect_containers",
    label: "Inspect Containers",
    description: "Inspect Docker and Podman container state without starting, stopping, or entering containers.",
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() {
      const parts = await Promise.all([
        optionalCommand("docker", ["ps", "-a", "--no-trunc"]),
        optionalCommand("podman", ["ps", "-a", "--no-trunc"]),
      ]);
      return textResult(parts.join("\n\n"));
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_kernel_modules",
    label: "Inspect Kernel Modules",
    description: "List loaded kernel modules or inspect metadata for one exact module.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ module: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (params.module) return textResult(await optionalCommand("modinfo", ["--", validateOperand(params.module, "kernel module")], 16000));
      return textResult(await optionalCommand("lsmod", [], 20000));
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_time_sync",
    label: "Inspect Time Sync",
    description: "Inspect clock, timezone, NTP synchronization, and timesync status.",
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() {
      const parts = await Promise.all([
        optionalCommand("timedatectl", ["status"]),
        optionalCommand("timedatectl", ["timesync-status"]),
      ]);
      return textResult(parts.join("\n\n"));
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_security_updates",
    label: "Inspect Security Updates",
    description: "Inspect available package updates without refreshing metadata or installing anything.",
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() {
      const parts = await Promise.all([
        optionalCommand("apt", ["list", "--upgradable"], 16000),
        optionalCommand("pacman", ["-Qu"], 16000),
      ]);
      return textResult(parts.join("\n\n"));
    },
  });
}
