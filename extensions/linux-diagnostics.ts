import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdir, readFile, statfs } from "node:fs/promises";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { commandAvailable, preview, registerLinuxTool, runCommand, textResult, validateOperand } from "./shared/linux-safety";

const guidelines = [
  "Read-only Linux diagnostics only; never mutate services, devices, containers, or kernel state.",
  "Keep output bounded and explain unavailable optional utilities.",
];

async function optionalCommand(command: string, args: string[], maxChars = 12000): Promise<string> {
  if (!(await commandAvailable(command))) return `$ ${command} ${args.join(" ")}\nUnavailable`;
  try {
    const result = await runCommand({ command, args }, { timeoutMs: 30_000, maxBuffer: 1024 * 1024, maxOutputChars: maxChars });
    return `$ ${command} ${args.join(" ")}\n${preview(result.stdout || result.stderr || "No output", maxChars)}`;
  } catch (error: any) {
    return `$ ${command} ${args.join(" ")}\n${preview(error.stdout || error.stderr || error.message || String(error), maxChars)}`;
  }
}

interface DiagnosticProbe { name: string; status: "ok" | "unavailable" | "error"; output: string }
interface ResourceSnapshot { at_ms: number; load?: Record<string, unknown>; memory?: Record<string, number>; pressure?: Record<string, unknown>; vmstat?: Record<string, number>; unavailable: string[] }

const anomalyPatterns: Array<{ category: string; severity: "warning" | "error" | "critical"; pattern: RegExp }> = [
  { category: "kernel_panic_lockup", severity: "critical", pattern: /kernel panic|not syncing|soft lockup|hard lockup|watchdog.*lockup|hung task/i },
  { category: "out_of_memory", severity: "critical", pattern: /out of memory|oom-kill|oom_reaper|killed process \d+/i },
  { category: "hardware_mce_edac", severity: "critical", pattern: /machine check|hardware error|\bmce\b|\bedac\b|uncorrected error|corrected error/i },
  { category: "storage_io", severity: "error", pattern: /\bnvme\b.*(?:error|reset|timeout|abort|failed)|I\/O error|blk_update_request|buffer i\/o|ata\d.*(?:error|failed|timeout)/i },
  { category: "filesystem", severity: "error", pattern: /EXT[234]-fs error|XFS.*(?:corruption|error)|BTRFS.*(?:error|corrupt)|filesystem.*read-only|journal.*abort/i },
  { category: "thermal_power", severity: "critical", pattern: /critical temperature|overheat|thermal.*(?:trip|thrott)|undervoltage|brownout|power (?:failure|loss)/i },
  { category: "gpu", severity: "error", pattern: /(?:amdgpu|i915|nvrm|nouveau|drm|gpu).*(?:hang|reset|fault|timeout|wedged|error)/i },
  { category: "network", severity: "warning", pattern: /NETDEV WATCHDOG|link is down|tx timeout|carrier lost|renamed from|martian source/i },
  { category: "service", severity: "error", pattern: /Failed to start|Main process exited|start request repeated too quickly|dependency failed|timed out waiting/i },
  { category: "security", severity: "warning", pattern: /apparmor=.*DENIED|avc:\s+denied|segfault at|general protection fault/i },
];

export async function probeCommand(name: string, command: string, args: string[], maxChars = 6000, timeoutMs = 15_000): Promise<DiagnosticProbe> {
  if (!(await commandAvailable(command))) return { name, status: "unavailable", output: `${command} is unavailable` };
  try {
    const result = await runCommand({ command, args }, { timeoutMs, maxBuffer: 512 * 1024, maxOutputChars: maxChars });
    return { name, status: "ok", output: preview(result.stdout || result.stderr || "No output", maxChars) };
  } catch (error: any) {
    return { name, status: "error", output: preview(error.stdout || error.stderr || error.message || String(error), maxChars) };
  }
}

export async function probeFile(name: string, file: string, maxChars = 6000): Promise<DiagnosticProbe> {
  try { return { name, status: "ok", output: preview(await readFile(file, "utf8"), maxChars) }; }
  catch (error: any) { return { name, status: error?.code === "ENOENT" ? "unavailable" : "error", output: `Unavailable or permission-restricted: ${String(error?.code ?? error?.message ?? error).slice(0, 200)}` }; }
}

function boundedTime(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a single bounded journal time expression`);
  return value;
}

export function classifyEvidence(text: string, maxEvidence = 100) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const categories: Record<string, { severity: string; count: number; evidence: string[] }> = {};
  const events: Array<{ category: string; severity: string; line: string }> = [];
  for (const line of lines) {
    for (const rule of anomalyPatterns) {
      if (!rule.pattern.test(line)) continue;
      const entry = categories[rule.category] ??= { severity: rule.severity, count: 0, evidence: [] };
      entry.count++;
      if (entry.evidence.length < 12) entry.evidence.push(line.slice(0, 1000));
      if (events.length < maxEvidence) events.push({ category: rule.category, severity: rule.severity, line: line.slice(0, 1000) });
    }
  }
  return { categories, events };
}

function parseKeyValues(text: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_()]+):?\s+(-?\d+(?:\.\d+)?)/);
    if (match) values[match[1]!] = Number(match[2]);
  }
  return values;
}

export function parsePressure(text: string) {
  const result: Record<string, Record<string, number>> = {};
  for (const line of text.split(/\r?\n/)) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (!kind) continue;
    result[kind] = Object.fromEntries(fields.map(field => field.split("=")).filter(parts => parts.length === 2).map(([key, value]) => [key, Number(value)]));
  }
  return result;
}

async function collectResourceSnapshot(): Promise<ResourceSnapshot> {
  const snapshot: ResourceSnapshot = { at_ms: Date.now(), unavailable: [] };
  try {
    const parts = (await readFile("/proc/loadavg", "utf8")).trim().split(/\s+/);
    snapshot.load = { one_minute: Number(parts[0]), five_minutes: Number(parts[1]), fifteen_minutes: Number(parts[2]), runnable: parts[3], latest_pid: Number(parts[4]) };
  } catch (error: any) { snapshot.unavailable.push(`/proc/loadavg: ${error?.code ?? error?.message ?? error}`); }
  try { snapshot.memory = parseKeyValues(await readFile("/proc/meminfo", "utf8")); }
  catch (error: any) { snapshot.unavailable.push(`/proc/meminfo: ${error?.code ?? error?.message ?? error}`); }
  const pressure: Record<string, unknown> = {};
  for (const kind of ["cpu", "memory", "io"]) {
    try { pressure[kind] = parsePressure(await readFile(`/proc/pressure/${kind}`, "utf8")); }
    catch (error: any) { snapshot.unavailable.push(`/proc/pressure/${kind}: ${error?.code ?? error?.message ?? error}`); }
  }
  snapshot.pressure = pressure;
  try { snapshot.vmstat = parseKeyValues((await readFile("/proc/vmstat", "utf8")).replace(/^(\S+)\s+/gm, "$1: ")); }
  catch (error: any) { snapshot.unavailable.push(`/proc/vmstat: ${error?.code ?? error?.message ?? error}`); }
  return snapshot;
}

function resourceDelta(first: ResourceSnapshot, last: ResourceSnapshot) {
  const keys = ["pswpin", "pswpout", "pgmajfault", "oom_kill", "pgscan_kswapd", "pgscan_direct", "pgsteal_kswapd", "pgsteal_direct"];
  return Object.fromEntries(keys.map(key => [key, (last.vmstat?.[key] ?? 0) - (first.vmstat?.[key] ?? 0)]));
}

export function extractServiceUnits(failedOutput: string, restartOutput: string, limit: number): string[] {
  const failedUnits = failedOutput.split(/\r?\n/).map(line => line.trim().split(/\s+/)[0] ?? "");
  const restartUnits = [...restartOutput.matchAll(/\b([A-Za-z0-9:_.@\\-]+\.service):/g)].map(match => match[1]!);
  return [...new Set([...failedUnits, ...restartUnits])].filter(unit => /^[A-Za-z0-9:_.@\\-]+\.(?:service|socket|mount|target|timer|path|scope|slice|device)$/.test(unit)).slice(0, limit);
}

export function parseNetworkDeviceCounters(text: string) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*([^:]+):\s+(.+)$/); if (!match) return [];
    const fields = match[2]!.trim().split(/\s+/).map(Number);
    if (fields.length < 16 || fields.some(value => !Number.isFinite(value))) return [];
    return [{ interface: match[1]!.trim(), receive_bytes: fields[0]!, receive_errors: fields[2]!, receive_drops: fields[3]!, transmit_bytes: fields[8]!, transmit_errors: fields[10]!, transmit_drops: fields[11]!, collisions: fields[13]!, has_errors: [fields[2], fields[3], fields[10], fields[11], fields[13]].some(value => (value ?? 0) > 0) }];
  });
}

function compactResource(snapshot: ResourceSnapshot) {
  const memoryKeys = ["MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SwapTotal", "SwapFree", "Dirty", "Writeback", "Slab", "SReclaimable", "PageTables"];
  const vmstatKeys = ["pswpin", "pswpout", "pgfault", "pgmajfault", "oom_kill", "pgscan_kswapd", "pgscan_direct", "pgsteal_kswapd", "pgsteal_direct"];
  return { at_ms: snapshot.at_ms, load: snapshot.load, memory_kb: Object.fromEntries(memoryKeys.map(key => [key, snapshot.memory?.[key]]).filter(([, value]) => value !== undefined)), pressure: snapshot.pressure, vmstat: Object.fromEntries(vmstatKeys.map(key => [key, snapshot.vmstat?.[key]]).filter(([, value]) => value !== undefined)), unavailable: snapshot.unavailable };
}

function incidentHypotheses(categories: Record<string, unknown>): string[] {
  const present = new Set(Object.keys(categories));
  const hypotheses: string[] = [];
  if (present.has("out_of_memory")) hypotheses.push("Memory exhaustion is supported by OOM evidence; inspect pressure, swap activity, and the named victim processes.");
  if (present.has("storage_io") && present.has("filesystem")) hypotheses.push("Storage and filesystem errors co-occur; investigate device health and preserve data before stress testing.");
  if (present.has("thermal_power")) hypotheses.push("Thermal or power evidence is present; correlate temperatures, voltage/power readings, and shutdown timing.");
  if (present.has("kernel_panic_lockup")) hypotheses.push("Kernel panic/lockup evidence is present; inspect pstore, taint, hardware counters, and affected drivers.");
  if (present.has("gpu")) hypotheses.push("GPU driver or hardware recovery events are present; correlate resets with workload and kernel taint.");
  if (present.has("network")) hypotheses.push("Network link or transmit evidence is present; inspect interface counters, routes, and driver logs.");
  return hypotheses;
}

function resultReport(report: unknown, details: Record<string, unknown> = {}) { return textResult(preview(JSON.stringify(report, null, 2), 30000), details); }

interface DashboardSnapshot {
  at_ms: number;
  cpu: { total: number; idle: number };
  load: number[];
  memory: { total_kb: number; available_kb: number; swap_total_kb: number; swap_free_kb: number };
  pressure: { cpu: number; memory: number; io: number };
  network: { received_bytes: number; transmitted_bytes: number; errors_drops: number };
  disk: { read_sectors: number; written_sectors: number };
  filesystem_used_percent?: number;
  max_temperature_c?: number;
  uptime_seconds?: number;
  processes: string[];
  unavailable: string[];
}

function pressureAvg10(text: string): number { return Number(text.match(/^some\s+avg10=(\d+(?:\.\d+)?)/m)?.[1] ?? 0); }

export async function collectDashboardSnapshot(): Promise<DashboardSnapshot> {
  const snapshot: DashboardSnapshot = { at_ms: Date.now(), cpu: { total: 0, idle: 0 }, load: [], memory: { total_kb: 0, available_kb: 0, swap_total_kb: 0, swap_free_kb: 0 }, pressure: { cpu: 0, memory: 0, io: 0 }, network: { received_bytes: 0, transmitted_bytes: 0, errors_drops: 0 }, disk: { read_sectors: 0, written_sectors: 0 }, processes: [], unavailable: [] };
  const read = async (file: string) => { try { return await readFile(file, "utf8"); } catch (error: any) { snapshot.unavailable.push(`${file}: ${error?.code ?? error?.message ?? error}`); return ""; } };
  const [stat, loadavg, meminfo, cpuPressure, memoryPressure, ioPressure, netdev, diskstats, uptime] = await Promise.all([read("/proc/stat"), read("/proc/loadavg"), read("/proc/meminfo"), read("/proc/pressure/cpu"), read("/proc/pressure/memory"), read("/proc/pressure/io"), read("/proc/net/dev"), read("/proc/diskstats"), read("/proc/uptime")]);
  const cpu = stat.match(/^cpu\s+(.+)$/m)?.[1]?.trim().split(/\s+/).map(Number) ?? [];
  snapshot.cpu.total = cpu.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  snapshot.cpu.idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
  snapshot.load = loadavg.trim().split(/\s+/).slice(0, 3).map(Number).filter(Number.isFinite);
  const memory = parseKeyValues(meminfo);
  snapshot.memory = { total_kb: memory.MemTotal ?? 0, available_kb: memory.MemAvailable ?? 0, swap_total_kb: memory.SwapTotal ?? 0, swap_free_kb: memory.SwapFree ?? 0 };
  snapshot.pressure = { cpu: pressureAvg10(cpuPressure), memory: pressureAvg10(memoryPressure), io: pressureAvg10(ioPressure) };
  const interfaces = parseNetworkDeviceCounters(netdev).filter(item => item.interface !== "lo");
  snapshot.network = { received_bytes: interfaces.reduce((sum, item) => sum + item.receive_bytes, 0), transmitted_bytes: interfaces.reduce((sum, item) => sum + item.transmit_bytes, 0), errors_drops: interfaces.reduce((sum, item) => sum + item.receive_errors + item.receive_drops + item.transmit_errors + item.transmit_drops + item.collisions, 0) };
  for (const line of diskstats.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/); const device = fields[2] ?? "";
    if (!/^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|dm-\d+|md\d+)$/.test(device)) continue;
    snapshot.disk.read_sectors += Number(fields[5] ?? 0); snapshot.disk.written_sectors += Number(fields[9] ?? 0);
  }
  snapshot.uptime_seconds = Number(uptime.trim().split(/\s+/)[0]);
  try { const root = await statfs("/"); snapshot.filesystem_used_percent = root.blocks > 0 ? (1 - Number(root.bavail) / Number(root.blocks)) * 100 : undefined; }
  catch (error: any) { snapshot.unavailable.push(`statfs(/): ${error?.code ?? error?.message ?? error}`); }
  try {
    const temperatures: number[] = [];
    for (const zone of (await readdir("/sys/class/thermal")).filter(name => /^thermal_zone\d+$/.test(name)).slice(0, 64)) {
      const raw = Number(await readFile(`/sys/class/thermal/${zone}/temp`, "utf8").catch(() => "NaN"));
      if (Number.isFinite(raw)) temperatures.push(raw / 1000);
    }
    if (temperatures.length > 0) snapshot.max_temperature_c = Math.max(...temperatures);
  } catch (error: any) { snapshot.unavailable.push(`/sys/class/thermal: ${error?.code ?? error?.message ?? error}`); }
  try {
    const processes = await runCommand({ command: "ps", args: ["-eo", "pid,stat,pcpu,pmem,rss,comm", "--sort=-pcpu"] }, { timeoutMs: 5000, maxBuffer: 64 * 1024, maxOutputChars: 12_000 });
    snapshot.processes = processes.stdout.split(/\r?\n/).slice(0, 13);
  } catch (error: any) { snapshot.unavailable.push(`ps: ${error?.code ?? error?.message ?? error}`); }
  return snapshot;
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B/s";
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"]; let amount = value; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

class SystemDashboardComponent {
  private current: DashboardSnapshot;
  private previous: DashboardSnapshot;
  private interval?: ReturnType<typeof setInterval>;
  private refreshMs: number;
  private paused = false;
  private busy = false;
  private version = 0;
  private cachedVersion = -1;
  private cachedWidth = 0;
  private cachedLines: string[] = [];

  constructor(private tui: { requestRender(): void }, private theme: any, initial: DashboardSnapshot, refreshMs: number, private close: () => void) {
    this.current = initial; this.previous = initial; this.refreshMs = refreshMs; this.start();
  }

  private start() { this.stop(); this.interval = setInterval(() => void this.refresh(), this.refreshMs); }
  private stop() { if (this.interval) clearInterval(this.interval); this.interval = undefined; }
  private async refresh() {
    if (this.paused || this.busy) return;
    this.busy = true;
    try { const next = await collectDashboardSnapshot(); this.previous = this.current; this.current = next; this.version++; this.tui.requestRender(); }
    finally { this.busy = false; }
  }
  dispose() { this.stop(); }
  invalidate() { this.cachedVersion = -1; }
  handleInput(data: string) {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") { this.dispose(); this.close(); return; }
    if (data === "p" || data === "P" || matchesKey(data, "space")) { this.paused = !this.paused; this.version++; this.tui.requestRender(); return; }
    if (data === "r" || data === "R") { void this.refresh(); return; }
    if (data === "+" || data === "=") { this.refreshMs = Math.max(500, this.refreshMs - 500); this.start(); this.version++; this.tui.requestRender(); }
    if (data === "-" || data === "_") { this.refreshMs = Math.min(5000, this.refreshMs + 500); this.start(); this.version++; this.tui.requestRender(); }
  }
  render(width: number): string[] {
    if (this.cachedVersion === this.version && this.cachedWidth === width) return this.cachedLines;
    const elapsed = Math.max(0.001, (this.current.at_ms - this.previous.at_ms) / 1000);
    const totalDelta = this.current.cpu.total - this.previous.cpu.total;
    const idleDelta = this.current.cpu.idle - this.previous.cpu.idle;
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
    const memoryPercent = this.current.memory.total_kb > 0 ? (1 - this.current.memory.available_kb / this.current.memory.total_kb) * 100 : 0;
    const swapPercent = this.current.memory.swap_total_kb > 0 ? (1 - this.current.memory.swap_free_kb / this.current.memory.swap_total_kb) * 100 : 0;
    const rxRate = (this.current.network.received_bytes - this.previous.network.received_bytes) / elapsed;
    const txRate = (this.current.network.transmitted_bytes - this.previous.network.transmitted_bytes) / elapsed;
    const readRate = (this.current.disk.read_sectors - this.previous.disk.read_sectors) * 512 / elapsed;
    const writeRate = (this.current.disk.written_sectors - this.previous.disk.written_sectors) * 512 / elapsed;
    const color = (value: number, text: string) => value >= 90 ? this.theme.fg("error", text) : value >= 75 ? this.theme.fg("warning", text) : this.theme.fg("success", text);
    const bar = (label: string, value: number) => { const cells = Math.max(8, Math.min(28, Math.floor((width - 24) / 2))); const filled = Math.round(Math.max(0, Math.min(100, value)) / 100 * cells); return `${label.padEnd(8)} ${color(value, "█".repeat(filled))}${this.theme.fg("dim", "░".repeat(cells - filled))} ${value.toFixed(1).padStart(5)}%`; };
    const lines = [
      this.theme.fg("accent", this.theme.bold(`KEYLIME SYSTEM DASHBOARD`)) + this.theme.fg("dim", `  ${this.paused ? "PAUSED" : `${(this.refreshMs / 1000).toFixed(1)}s refresh`}  uptime ${Math.floor((this.current.uptime_seconds ?? 0) / 3600)}h`),
      this.theme.fg("dim", "─".repeat(Math.max(1, width))),
      `${bar("CPU", cpuPercent)}   load ${this.current.load.map(value => value.toFixed(2)).join(" ") || "n/a"}`,
      `${bar("Memory", memoryPercent)}   swap ${swapPercent.toFixed(1)}%`,
      `${bar("Root FS", this.current.filesystem_used_percent ?? 0)}   temp ${this.current.max_temperature_c?.toFixed(1) ?? "n/a"}°C`,
      `PSI avg10  cpu ${this.current.pressure.cpu.toFixed(2)}%  memory ${this.current.pressure.memory.toFixed(2)}%  I/O ${this.current.pressure.io.toFixed(2)}%`,
      `Network    ↓ ${formatRate(rxRate)}   ↑ ${formatRate(txRate)}   cumulative errors/drops ${this.current.network.errors_drops}`,
      `Storage    read ${formatRate(readRate)}   write ${formatRate(writeRate)}`,
      this.theme.fg("dim", "─".repeat(Math.max(1, width))),
      this.theme.fg("accent", "Top processes by CPU"),
      ...this.current.processes.slice(0, 12).map((line, index) => index === 0 ? this.theme.fg("muted", line) : line),
      ...(this.current.unavailable.length > 0 ? [this.theme.fg("warning", `${this.current.unavailable.length} interface(s) unavailable or restricted`)] : []),
      this.theme.fg("dim", "q/esc close • p/space pause • r refresh • +/- speed"),
    ];
    this.cachedLines = lines.map(line => truncateToWidth(line, Math.max(1, width)));
    this.cachedWidth = width; this.cachedVersion = this.version; return this.cachedLines;
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

  registerLinuxTool(pi, {
    name: "diagnose_system_health",
    label: "Diagnose System Health",
    description: "Run a resilient, bounded cross-system health snapshot covering resources, processes, storage, services, kernel evidence, and networking.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ duration_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })), process_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id: string, params: any) {
      const duration = params.duration_seconds ?? 0;
      const processLimit = params.process_limit ?? 15;
      const first = await collectResourceSnapshot();
      const probesPromise = Promise.all([
        probeCommand("top_cpu_processes", "ps", ["-eo", "pid,ppid,user,stat,pcpu,pmem,rss,etime,comm", "--sort=-pcpu"]),
        probeCommand("top_memory_processes", "ps", ["-eo", "pid,ppid,user,stat,pcpu,pmem,rss,etime,comm", "--sort=-rss"]),
        probeCommand("filesystem_capacity", "df", ["-hPT"]),
        probeCommand("filesystem_inodes", "df", ["-hiP"]),
        probeCommand("failed_services", "systemctl", ["--failed", "--no-legend", "--plain"]),
        probeCommand("socket_summary", "ss", ["-s"]),
        probeCommand("network_links", "ip", ["-s", "link", "show"]),
        probeCommand("current_boot_errors", "journalctl", ["--no-pager", "-b", "-p", "err", "-n", "200"]),
        probeFile("software_raid", "/proc/mdstat"),
      ]);
      if (duration > 0) await new Promise(resolve => setTimeout(resolve, duration * 1000));
      const last = duration > 0 ? await collectResourceSnapshot() : first;
      const probes = await probesPromise;
      for (const probe of probes.filter(probe => probe.name.startsWith("top_"))) probe.output = probe.output.split(/\r?\n/).slice(0, processLimit + 1).join("\n");
      const classified = classifyEvidence(probes.map(probe => probe.output).join("\n"), 100);
      const severities = Object.values(classified.categories).map(category => category.severity);
      const overall = severities.includes("critical") ? "critical evidence detected" : severities.includes("error") ? "degraded evidence detected" : severities.includes("warning") ? "warnings detected" : "no known critical signatures detected";
      return resultReport({ overall, sampled_seconds: duration, resources: { first: compactResource(first), last: compactResource(last), vmstat_delta: resourceDelta(first, last) }, anomalies: classified.categories, hypotheses: incidentHypotheses(classified.categories), probes }, { process_limit: processLimit, duration_seconds: duration });
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_kernel_anomalies",
    label: "Inspect Kernel Anomalies",
    description: "Classify bounded kernel journal evidence for panics, lockups, OOM, hardware, storage, filesystem, GPU, thermal, power, network, and security faults.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ boot: Type.Optional(Type.Integer({ minimum: -100, maximum: 0 })), since: Type.Optional(Type.String({ maxLength: 200 })), until: Type.Optional(Type.String({ maxLength: 200 })), lines: Type.Optional(Type.Integer({ minimum: 50, maximum: 2000 })) }),
    async execute(_id: string, params: any) {
      const lineLimit = params.lines ?? 500;
      const args = ["--no-pager", "-k", `--boot=${params.boot ?? 0}`, "-n", String(lineLimit), "-o", "short-iso", ...(params.since ? [`--since=${boundedTime(params.since, "since")}`] : []), ...(params.until ? [`--until=${boundedTime(params.until, "until")}`] : [])];
      const journal = await probeCommand("kernel_journal", "journalctl", args, 20000, 30_000);
      const classified = classifyEvidence(journal.output, 200);
      return resultReport({ boot: params.boot ?? 0, status: journal.status, categories: classified.categories, hypotheses: incidentHypotheses(classified.categories), events: classified.events, note: "Signatures are diagnostic evidence, not definitive root-cause determinations." }, { lines: lineLimit });
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_resource_pressure",
    label: "Inspect Resource Pressure",
    description: "Sample load, PSI, memory, swap, reclaim, major faults, OOM counters, and top CPU/memory processes.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ duration_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })), sample_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), process_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id: string, params: any) {
      const duration = params.duration_seconds ?? 0;
      const sampleCount = duration > 0 ? (params.sample_count ?? 2) : 1;
      const processLimit = params.process_limit ?? 20;
      const snapshots: ResourceSnapshot[] = [];
      for (let index = 0; index < sampleCount; index++) {
        snapshots.push(await collectResourceSnapshot());
        if (index + 1 < sampleCount) await new Promise(resolve => setTimeout(resolve, duration * 1000 / (sampleCount - 1)));
      }
      const [cpu, memory] = await Promise.all([
        probeCommand("top_cpu_processes", "ps", ["-eo", "pid,ppid,user,stat,pcpu,pmem,rss,vsz,etime,comm", "--sort=-pcpu"]),
        probeCommand("top_memory_processes", "ps", ["-eo", "pid,ppid,user,stat,pcpu,pmem,rss,vsz,etime,comm", "--sort=-rss"]),
      ]);
      cpu.output = cpu.output.split(/\r?\n/).slice(0, processLimit + 1).join("\n");
      memory.output = memory.output.split(/\r?\n/).slice(0, processLimit + 1).join("\n");
      return resultReport({ sampled_seconds: duration, samples: snapshots.map(compactResource), vmstat_delta: resourceDelta(snapshots[0]!, snapshots.at(-1)!), processes: [cpu, memory] }, { samples: sampleCount, process_limit: processLimit });
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_service_failures",
    label: "Inspect Service Failures",
    description: "Inspect failed systemd units, exit results, restart counts, dependency failures, timeouts, and bounded recent logs.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ since: Type.Optional(Type.String({ maxLength: 200 })), max_units: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), lines_per_unit: Type.Optional(Type.Integer({ minimum: 10, maximum: 200 })) }),
    async execute(_id: string, params: any) {
      const maxUnits = params.max_units ?? 10;
      const lines = params.lines_per_unit ?? 60;
      const failed = await probeCommand("failed_units", "systemctl", ["--failed", "--no-legend", "--plain"], 10000);
      const restartJournal = await probeCommand("restart_loop_evidence", "journalctl", ["--no-pager", "-b", "-n", "1000", "--grep=(Scheduled restart job|start request repeated too quickly|Main process exited|Failed with result|dependency failed|timed out)", ...(params.since ? [`--since=${boundedTime(params.since, "since")}`] : [])], 10000);
      const units = extractServiceUnits(failed.output, restartJournal.output, maxUnits);
      const reports: Record<string, unknown>[] = [];
      for (const unit of units) {
        const show = await probeCommand(`${unit}_state`, "systemctl", ["show", unit, "--no-pager", "--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts,StateChangeTimestamp,InactiveExitTimestamp"], 5000);
        const journalArgs = ["--no-pager", "-b", `--unit=${unit}`, "-n", String(lines), ...(params.since ? [`--since=${boundedTime(params.since, "since")}`] : [])];
        const journal = await probeCommand(`${unit}_journal`, "journalctl", journalArgs, 6000);
        const restartMatches = journal.output.match(/Scheduled restart job|start request repeated too quickly|Main process exited/gi) ?? [];
        reports.push({ unit, state: show, restart_or_crash_markers: restartMatches.length, journal, evidence: classifyEvidence(journal.output, 30).categories });
      }
      return resultReport({ failed_units_probe: failed, restart_loop_probe: restartJournal, units: reports, note: units.length === 0 ? "No failed or restart-looping units were reported, or systemd is unavailable." : undefined }, { units: units.length, lines_per_unit: lines });
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_storage_health",
    label: "Inspect Storage Health",
    description: "Inspect capacity, inode pressure, block devices, RAID, disk statistics, storage kernel errors, and optional read-only SMART/NVMe health.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ max_devices: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), include_device_health: Type.Optional(Type.Boolean()), journal_lines: Type.Optional(Type.Integer({ minimum: 20, maximum: 1000 })) }),
    async execute(_id: string, params: any) {
      const maxDevices = params.max_devices ?? 6;
      const journalLines = params.journal_lines ?? 300;
      const probes = await Promise.all([
        probeCommand("block_devices", "lsblk", ["-J", "-d", "-o", "NAME,PATH,TYPE,SIZE,MODEL,ROTA,RO,MOUNTPOINTS"], 12000),
        probeCommand("filesystem_capacity", "df", ["-hPT"], 10000),
        probeCommand("filesystem_inodes", "df", ["-hiP"], 10000),
        probeCommand("mounts", "findmnt", ["--noheadings", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"], 10000),
        probeFile("software_raid", "/proc/mdstat", 8000),
        probeFile("disk_statistics", "/proc/diskstats", 12000),
        probeCommand("storage_kernel_evidence", "journalctl", ["--no-pager", "-k", "-b", "-n", String(journalLines), "--grep=(I/O error|nvme|ata[0-9]|blk_update_request|filesystem error|EXT[234]-fs|XFS|BTRFS|md.*degrad)"], 12000),
      ]);
      let devices: any[] = [];
      try { devices = JSON.parse(probes[0]!.output).blockdevices?.filter((device: any) => device.type === "disk").slice(0, maxDevices) ?? []; } catch {}
      const health: DiagnosticProbe[] = [];
      if (params.include_device_health ?? true) {
        for (const device of devices) {
          const devicePath = String(device.path ?? "");
          if (!/^\/dev\/[A-Za-z0-9._-]+$/.test(devicePath)) continue;
          health.push(devicePath.includes("nvme")
            ? await probeCommand(`${devicePath}_nvme_health`, "nvme", ["smart-log", devicePath], 8000, 20_000)
            : await probeCommand(`${devicePath}_smart_health`, "smartctl", ["-H", "-A", "--", devicePath], 8000, 20_000));
        }
      }
      const classified = classifyEvidence(probes.map(probe => probe.output).join("\n"), 100);
      return resultReport({ devices, device_health: health, probes, anomalies: classified.categories, hypotheses: incidentHypotheses(classified.categories) }, { devices: devices.length, journal_lines: journalLines });
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_network_health",
    label: "Inspect Network Health",
    description: "Inspect interface errors and drops, routes, sockets, protocol counters, resolver state, driver evidence, and an optional bounded host probe.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ probe_host: Type.Optional(Type.String({ maxLength: 253 })), ping_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })), journal_lines: Type.Optional(Type.Integer({ minimum: 20, maximum: 1000 })) }),
    async execute(_id: string, params: any) {
      const journalLines = params.journal_lines ?? 300;
      const netDev = await probeFile("interface_counters", "/proc/net/dev", 12000);
      const interfaces = parseNetworkDeviceCounters(netDev.output);
      const probes = await Promise.all([
        probeCommand("link_state", "ip", ["-s", "link", "show"], 12000),
        probeCommand("ipv4_routes", "ip", ["route", "show"], 8000),
        probeCommand("ipv6_routes", "ip", ["-6", "route", "show"], 8000),
        probeCommand("socket_summary", "ss", ["-s"], 6000),
        probeCommand("resolver", "resolvectl", ["status"], 10000),
        probeFile("snmp_counters", "/proc/net/snmp", 12000),
        probeFile("extended_network_counters", "/proc/net/netstat", 12000),
        probeCommand("network_kernel_evidence", "journalctl", ["--no-pager", "-k", "-b", "-n", String(journalLines), "--grep=(NETDEV WATCHDOG|link.*down|tx timeout|carrier|firmware.*fail|renamed from|martian)"], 10000),
      ]);
      if (params.probe_host) {
        const host = validateOperand(params.probe_host, "probe host");
        probes.push(await probeCommand("host_resolution", "getent", ["ahosts", host], 5000));
        probes.push(await probeCommand("host_ping", "ping", ["-c", String(params.ping_count ?? 3), "--", host], 5000, 15_000));
      }
      const classified = classifyEvidence(probes.map(probe => probe.output).join("\n"), 100);
      return resultReport({ interfaces, interfaces_with_errors: interfaces.filter(item => item.has_errors), probes, anomalies: classified.categories, hypotheses: incidentHypotheses(classified.categories) }, { interfaces: interfaces.length, journal_lines: journalLines });
    },
  });

  registerLinuxTool(pi, {
    name: "inspect_boot_performance",
    label: "Inspect Boot Performance",
    description: "Inspect boot duration, slow units, critical chain, failed units, boot jobs, and bounded boot warnings.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ max_units: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), warning_lines: Type.Optional(Type.Integer({ minimum: 20, maximum: 1000 })) }),
    async execute(_id: string, params: any) {
      const maxUnits = params.max_units ?? 30;
      const warningLines = params.warning_lines ?? 200;
      const probes = await Promise.all([
        probeCommand("boot_time", "systemd-analyze", ["time"], 4000),
        probeCommand("slow_units", "systemd-analyze", ["blame", "--no-pager"], 12000),
        probeCommand("critical_chain", "systemd-analyze", ["critical-chain", "--no-pager"], 12000),
        probeCommand("failed_units", "systemctl", ["--failed", "--no-legend", "--plain"], 8000),
        probeCommand("pending_jobs", "systemctl", ["list-jobs", "--no-pager", "--no-legend"], 6000),
        probeCommand("boot_warnings", "journalctl", ["--no-pager", "-b", "-p", "warning", "-n", String(warningLines)], 12000),
      ]);
      const blame = probes.find(probe => probe.name === "slow_units");
      if (blame) blame.output = blame.output.split(/\r?\n/).slice(0, maxUnits).join("\n");
      const classified = classifyEvidence(probes.map(probe => probe.output).join("\n"), 100);
      return resultReport({ probes, anomalies: classified.categories, hypotheses: incidentHypotheses(classified.categories) }, { max_units: maxUnits, warning_lines: warningLines });
    },
  });

  registerLinuxTool(pi, {
    name: "correlate_system_incident",
    label: "Correlate System Incident",
    description: "Correlate bounded journal evidence across kernel, memory, storage, hardware, GPU, network, service, power, and security categories in one time window.",
    promptGuidelines: guidelines,
    parameters: Type.Object({ since: Type.Optional(Type.String({ maxLength: 200 })), until: Type.Optional(Type.String({ maxLength: 200 })), boot: Type.Optional(Type.Integer({ minimum: -100, maximum: 0 })), lines: Type.Optional(Type.Integer({ minimum: 100, maximum: 3000 })), max_events: Type.Optional(Type.Integer({ minimum: 20, maximum: 500 })) }),
    async execute(_id: string, params: any) {
      const lineLimit = params.lines ?? 1200;
      const maxEvents = params.max_events ?? 200;
      const args = ["--no-pager", `--boot=${params.boot ?? 0}`, "-n", String(lineLimit), "-o", "short-iso", `--since=${boundedTime(params.since ?? "1 hour ago", "since")}`, ...(params.until ? [`--until=${boundedTime(params.until, "until")}`] : [])];
      const journal = await probeCommand("incident_journal", "journalctl", args, 24000, 30_000);
      const classified = classifyEvidence(journal.output, maxEvents);
      const severityCounts = classified.events.reduce<Record<string, number>>((counts, event) => { counts[event.severity] = (counts[event.severity] ?? 0) + 1; return counts; }, {});
      return resultReport({ window: { since: params.since ?? "1 hour ago", until: params.until ?? "now", boot: params.boot ?? 0 }, journal_status: journal.status, severity_counts: severityCounts, categories: classified.categories, hypotheses: incidentHypotheses(classified.categories), timeline: classified.events, caveat: "Correlation identifies co-occurring evidence and plausible investigation paths; it does not prove causation." }, { lines: lineLimit, max_events: maxEvents });
    },
  });

  pi.registerCommand("system-dashboard", {
    description: "Open a live, read-only Linux system diagnostics dashboard.",
    handler: async (args: string, ctx: any) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("The system dashboard requires interactive TUI mode.", "error"); return; }
      if (process.platform !== "linux") { ctx.ui.notify("The system dashboard requires Linux.", "error"); return; }
      const requestedSeconds = args.trim() ? Number(args.trim()) : 1;
      if (!Number.isFinite(requestedSeconds)) { ctx.ui.notify("Usage: /system-dashboard [refresh-seconds between 0.5 and 5]", "error"); return; }
      const refreshMs = Math.round(Math.min(5, Math.max(0.5, requestedSeconds)) * 1000);
      const initial = await collectDashboardSnapshot();
      let component: SystemDashboardComponent | undefined;
      try {
        await ctx.ui.custom((tui: { requestRender(): void }, theme: any, _keybindings: unknown, done: (value: undefined) => void) => {
          component = new SystemDashboardComponent(tui, theme, initial, refreshMs, () => done(undefined));
          return component;
        });
      } finally { component?.dispose(); }
    },
  });
}
