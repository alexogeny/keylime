import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { registerLinuxTool, runCommand, textResult, preview } from "./shared/linux-safety";

const guidelines = ["Safe Linux hardware/OS inspection only.", "Keep output bounded and prefer parsed tools over raw shell."];
const SYSFS_ROOTS = ["/sys/class/hwmon", "/sys/class/thermal", "/sys/class/power_supply", "/sys/class/powercap"];

interface Reading { key: string; kind: "temperature" | "fan" | "voltage" | "power" | "energy" | "current" | "capacity"; value: number; unit: string }
interface Snapshot { at_ms: number; readings: Reading[]; interfaces: Record<string, string>; issues: string[] }

async function fileOrCommand(file: string, command: string, args: string[] = []) { try { return preview(await readFile(file, "utf8")); } catch { const r = await runCommand({ command, args }); return r.stdout || r.stderr; } }
async function readText(file: string): Promise<string> { return (await readFile(file, "utf8")).trim(); }
async function readNumber(file: string): Promise<number | undefined> { try { const value = Number(await readText(file)); return Number.isFinite(value) ? value : undefined; } catch { return undefined; } }
async function namesAt(root: string, limit: number): Promise<{ names: string[]; status: string }> {
  try { const names = (await readdir(root)).sort().slice(0, limit); return { names, status: names.length > 0 ? "available" : "available (empty)" }; }
  catch (error: any) { return { names: [], status: `unavailable or permission-restricted: ${String(error?.code ?? error?.message ?? error).slice(0, 120)}` }; }
}

function addReading(readings: Reading[], key: string, kind: Reading["kind"], raw: number | undefined, divisor: number, unit: string) {
  if (raw !== undefined) readings.push({ key, kind, value: raw / divisor, unit });
}

async function collectThermalPowerSnapshot(): Promise<Snapshot> {
  const snapshot: Snapshot = { at_ms: Date.now(), readings: [], interfaces: {}, issues: [] };

  const hwmon = await namesAt(SYSFS_ROOTS[0]!, 32); snapshot.interfaces.hwmon = hwmon.status;
  for (const device of hwmon.names) {
    const root = path.join(SYSFS_ROOTS[0]!, device);
    const files = await namesAt(root, 160);
    let deviceName = device;
    try { deviceName = await readText(path.join(root, "name")); } catch {}
    for (const file of files.names) {
      const match = file.match(/^(temp\d+|fan\d+|in\d+|power\d+|energy\d+)_(input|average)$/);
      if (!match) continue;
      const raw = await readNumber(path.join(root, file));
      const key = `hwmon/${deviceName}/${match[1]}/${match[2]}`;
      if (match[1]!.startsWith("temp")) addReading(snapshot.readings, key, "temperature", raw, 1000, "C");
      else if (match[1]!.startsWith("fan")) addReading(snapshot.readings, key, "fan", raw, 1, "RPM");
      else if (match[1]!.startsWith("in")) addReading(snapshot.readings, key, "voltage", raw, 1000, "V");
      else if (match[1]!.startsWith("power")) addReading(snapshot.readings, key, "power", raw, 1_000_000, "W");
      else addReading(snapshot.readings, key, "energy", raw, 1_000_000, "J");
    }
  }

  const thermal = await namesAt(SYSFS_ROOTS[1]!, 128); snapshot.interfaces.thermal = thermal.status;
  for (const zone of thermal.names.filter(name => /^thermal_zone\d+$/.test(name))) {
    const root = path.join(SYSFS_ROOTS[1]!, zone);
    let type = zone;
    try { type = await readText(path.join(root, "type")); } catch {}
    addReading(snapshot.readings, `thermal/${zone}/${type}`, "temperature", await readNumber(path.join(root, "temp")), 1000, "C");
  }

  const supplies = await namesAt(SYSFS_ROOTS[2]!, 64); snapshot.interfaces.power_supply = supplies.status;
  for (const supply of supplies.names) {
    const root = path.join(SYSFS_ROOTS[2]!, supply);
    addReading(snapshot.readings, `power_supply/${supply}/voltage_now`, "voltage", await readNumber(path.join(root, "voltage_now")), 1_000_000, "V");
    addReading(snapshot.readings, `power_supply/${supply}/current_now`, "current", await readNumber(path.join(root, "current_now")), 1_000_000, "A");
    addReading(snapshot.readings, `power_supply/${supply}/power_now`, "power", await readNumber(path.join(root, "power_now")), 1_000_000, "W");
    addReading(snapshot.readings, `power_supply/${supply}/capacity`, "capacity", await readNumber(path.join(root, "capacity")), 1, "%");
    const energyMicroWh = await readNumber(path.join(root, "energy_now"));
    addReading(snapshot.readings, `power_supply/${supply}/energy_now`, "energy", energyMicroWh === undefined ? undefined : energyMicroWh * 3600, 1_000_000, "J");
  }

  const powercap = await namesAt(SYSFS_ROOTS[3]!, 64); snapshot.interfaces.powercap = powercap.status;
  let visited = 0;
  async function visitPowercap(root: string, depth: number): Promise<void> {
    if (depth > 4 || visited++ >= 128) return;
    const entries = await namesAt(root, 80);
    if (!entries.status.startsWith("available")) { snapshot.issues.push(`${root}: ${entries.status}`); return; }
    let zoneName = path.basename(root);
    try { zoneName = await readText(path.join(root, "name")); } catch {}
    addReading(snapshot.readings, `powercap/${zoneName}/energy_uj`, "energy", await readNumber(path.join(root, "energy_uj")), 1_000_000, "J");
    for (const entry of entries.names.filter(name => name.includes(":"))) await visitPowercap(path.join(root, entry), depth + 1);
  }
  for (const zone of powercap.names) await visitPowercap(path.join(SYSFS_ROOTS[3]!, zone), 0);
  return snapshot;
}

function summarizeKind(snapshots: Snapshot[], kind: Reading["kind"]) {
  const grouped = new Map<string, Reading[]>();
  for (const snapshot of snapshots) for (const reading of snapshot.readings) if (reading.kind === kind) grouped.set(reading.key, [...(grouped.get(reading.key) ?? []), reading]);
  return [...grouped.entries()].map(([sensor, values]) => ({ sensor, unit: values[0]!.unit, min: Math.min(...values.map(value => value.value)), max: Math.max(...values.map(value => value.value)), latest: values.at(-1)!.value }));
}

function energyAveragePower(snapshots: Snapshot[]) {
  if (snapshots.length < 2) return [];
  const first = new Map(snapshots[0]!.readings.filter(reading => reading.kind === "energy").map(reading => [reading.key, reading.value]));
  const elapsedSeconds = (snapshots.at(-1)!.at_ms - snapshots[0]!.at_ms) / 1000;
  if (elapsedSeconds <= 0) return [];
  return snapshots.at(-1)!.readings.filter(reading => reading.kind === "energy" && first.has(reading.key)).map(reading => ({ sensor: reading.key, average_watts: Math.abs(reading.value - first.get(reading.key)!) / elapsedSeconds }));
}

async function boundedFile(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try { const buffer = Buffer.alloc(maxBytes); const result = await handle.read(buffer, 0, maxBytes, 0); return buffer.subarray(0, result.bytesRead).toString("utf8"); }
  finally { await handle.close(); }
}

const taintFlags = ["proprietary module", "forced module load", "unsupported SMP", "forced module unload", "machine check", "bad page", "user-requested taint", "kernel died", "ACPI override", "kernel warning", "staging driver", "firmware workaround", "out-of-tree module", "unsigned module", "soft lockup", "auxiliary taint", "randstruct", "live patch", "test taint"];
function decodeTaint(value: number) { return taintFlags.flatMap((name, bit) => (value & (2 ** bit)) !== 0 ? [{ bit, name }] : []); }

async function inspectCrashEvidence(maxFiles: number, maxChars: number) {
  const report: Record<string, unknown> = {};
  const pstore = await namesAt("/sys/fs/pstore", maxFiles);
  if (!pstore.status.startsWith("available")) report.pstore = { status: pstore.status, files: [] };
  else {
    const files = [] as Array<{ name: string; content?: string; status?: string }>;
    let remaining = maxChars;
    for (const name of pstore.names) {
      if (remaining <= 0) break;
      try { const content = await boundedFile(path.join("/sys/fs/pstore", name), remaining); remaining -= content.length; files.push({ name, content }); }
      catch (error: any) { files.push({ name, status: `unavailable or permission-restricted: ${String(error?.code ?? error?.message ?? error).slice(0, 120)}` }); }
    }
    report.pstore = { status: pstore.status, files, truncated: remaining <= 0 };
  }

  const edacRoot = "/sys/devices/system/edac/mc";
  const edacStart = await namesAt(edacRoot, 64);
  const counters: Array<{ path: string; value: number }> = [];
  let visited = 0;
  async function visitEdac(root: string, depth: number): Promise<void> {
    if (depth > 5 || visited++ >= 192) return;
    const entries = await namesAt(root, 96);
    for (const name of entries.names) {
      const child = path.join(root, name);
      if (/^(?:ce|ue)(?:_noinfo)?_count$/.test(name)) { const value = await readNumber(child); if (value !== undefined) counters.push({ path: child, value }); }
      else if (/^(?:mc|csrow|channel|rank|dimm)\d+/i.test(name)) await visitEdac(child, depth + 1);
    }
  }
  if (edacStart.status.startsWith("available")) await visitEdac(edacRoot, 0);
  report.edac = { status: edacStart.status, counters };

  try { const value = Number(await readText("/proc/sys/kernel/tainted")); report.kernel_taint = { status: "available", value, flags: decodeTaint(value) }; }
  catch (error: any) { report.kernel_taint = { status: `unavailable or permission-restricted: ${String(error?.code ?? error?.message ?? error).slice(0, 120)}` }; }

  const dmiFields = ["board_vendor", "board_name", "board_version", "bios_vendor", "bios_version", "bios_date", "product_name", "product_version"];
  const dmi: Record<string, string> = {};
  const dmiErrors: string[] = [];
  for (const field of dmiFields) {
    try { dmi[field] = await readText(path.join("/sys/class/dmi/id", field)); }
    catch (error: any) { dmiErrors.push(`${field}: ${String(error?.code ?? error?.message ?? error).slice(0, 80)}`); }
  }
  report.dmi = Object.keys(dmi).length > 0 ? { status: "available", fields: dmi, unavailable_fields: dmiErrors } : { status: "unavailable or permission-restricted", unavailable_fields: dmiErrors };
  return report;
}

export default function (pi: ExtensionAPI) {
  registerLinuxTool(pi, { name: "inspect_kernel", label: "Inspect Kernel", description: "Inspect kernel release and command line.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "uname", args: ["-a"] }); return textResult(r.stdout); }});
  registerLinuxTool(pi, { name: "inspect_cpu", label: "Inspect CPU", description: "Inspect CPU model and topology.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { return textResult(await fileOrCommand("/proc/cpuinfo", "lscpu")); }});
  registerLinuxTool(pi, { name: "inspect_memory", label: "Inspect Memory", description: "Inspect memory totals and pressure basics.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { return textResult(await fileOrCommand("/proc/meminfo", "free", ["-h"])); }});
  registerLinuxTool(pi, { name: "inspect_disks", label: "Inspect Disks", description: "Inspect block devices without mutation.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "lsblk", args: ["-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL"] }); return textResult(r.stdout); }});
  registerLinuxTool(pi, { name: "inspect_mounts", label: "Inspect Mounts", description: "Inspect mounted filesystems.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "findmnt", args: ["--noheadings"] }); return textResult(r.stdout); }});
  registerLinuxTool(pi, { name: "inspect_gpu", label: "Inspect GPU", description: "Inspect GPU devices and NVIDIA status when available.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { let out = ""; try { out += (await runCommand({ command: "lspci", args: [] })).stdout; } catch (e: any) { out += e.message; } try { out += "\n\n" + (await runCommand({ command: "nvidia-smi", args: [] })).stdout; } catch {} return textResult(out.trim() || "No GPU inspection output"); }});
  registerLinuxTool(pi, { name: "inspect_network_interfaces", label: "Inspect Network Interfaces", description: "Inspect network interfaces and addresses.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute() { const r = await runCommand({ command: "ip", args: ["addr", "show"] }); return textResult(r.stdout); }});
  registerLinuxTool(pi, { name: "inspect_thermal_power", label: "Inspect Thermal and Power", description: "Inspect bounded thermal, fan, voltage, power, and energy readings from standard kernel interfaces.", promptGuidelines: guidelines, parameters: Type.Object({ duration_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })), sample_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }), async execute(_id: string, params: any) {
    const durationSeconds = params.duration_seconds ?? 0;
    const sampleCount = durationSeconds > 0 ? (params.sample_count ?? 2) : 1;
    const snapshots: Snapshot[] = [];
    for (let index = 0; index < sampleCount; index++) {
      snapshots.push(await collectThermalPowerSnapshot());
      if (index + 1 < sampleCount) await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000 / (sampleCount - 1)));
    }
    const report = { duration_seconds: durationSeconds, samples: snapshots.length, interfaces: snapshots.at(-1)?.interfaces ?? {}, issues: snapshots.flatMap(snapshot => snapshot.issues).slice(0, 100), temperatures: summarizeKind(snapshots, "temperature"), fans: summarizeKind(snapshots, "fan"), voltages: summarizeKind(snapshots, "voltage"), power: summarizeKind(snapshots, "power"), current: summarizeKind(snapshots, "current"), capacity: summarizeKind(snapshots, "capacity"), energy_derived_average_power: energyAveragePower(snapshots) };
    return textResult(preview(JSON.stringify(report, null, 2), 30000), { samples: snapshots.length, duration_seconds: durationSeconds });
  }});
  registerLinuxTool(pi, { name: "inspect_hardware_crash_evidence", label: "Inspect Hardware Crash Evidence", description: "Inspect bounded pstore crash records, EDAC counters, kernel taint, and DMI identification.", promptGuidelines: guidelines, parameters: Type.Object({ max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), max_chars: Type.Optional(Type.Integer({ minimum: 100, maximum: 20000 })) }), async execute(_id: string, params: any) {
    const report = await inspectCrashEvidence(params.max_files ?? 10, params.max_chars ?? 12000);
    return textResult(preview(JSON.stringify(report, null, 2), 30000), { max_files: params.max_files ?? 10, max_chars: params.max_chars ?? 12000 });
  }});
}
