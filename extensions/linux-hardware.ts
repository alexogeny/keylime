import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { runCommand, textResult, preview } from "./shared/linux-safety";

const guidelines = ["Safe Linux hardware/OS inspection only.", "Keep output bounded and prefer parsed tools over raw shell."];
async function fileOrCommand(file: string, command: string, args: string[] = []) { try { return preview(await readFile(file, "utf8")); } catch { const r = await runCommand({ command, args }); return r.stdout || r.stderr; } }

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "inspect_kernel", label: "Inspect Kernel", description: "Inspect kernel release and command line.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "uname", args: ["-a"] }); return textResult(r.stdout); }});
  pi.registerTool({ name: "inspect_cpu", label: "Inspect CPU", description: "Inspect CPU model and topology.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { return textResult(await fileOrCommand("/proc/cpuinfo", "lscpu")); }});
  pi.registerTool({ name: "inspect_memory", label: "Inspect Memory", description: "Inspect memory totals and pressure basics.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { return textResult(await fileOrCommand("/proc/meminfo", "free", ["-h"])); }});
  pi.registerTool({ name: "inspect_disks", label: "Inspect Disks", description: "Inspect block devices without mutation.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "lsblk", args: ["-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL"] }); return textResult(r.stdout); }});
  pi.registerTool({ name: "inspect_mounts", label: "Inspect Mounts", description: "Inspect mounted filesystems.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "findmnt", args: ["--noheadings"] }); return textResult(r.stdout); }});
  pi.registerTool({ name: "inspect_gpu", label: "Inspect GPU", description: "Inspect GPU devices and NVIDIA status when available.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { let out = ""; try { out += (await runCommand({ command: "lspci", args: [] })).stdout; } catch (e: any) { out += e.message; } try { out += "\n\n" + (await runCommand({ command: "nvidia-smi", args: [] })).stdout; } catch {} return textResult(out.trim() || "No GPU inspection output"); }});
  pi.registerTool({ name: "inspect_network_interfaces", label: "Inspect Network Interfaces", description: "Inspect network interfaces and addresses.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "ip", args: ["addr", "show"] }); return textResult(r.stdout); }});
}
