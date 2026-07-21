import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { open } from "node:fs/promises";
import { preview, redactSecrets, registerLinuxTool, resolveWithinRoots, runCommand, textResult, validateOperand } from "./shared/linux-safety";

const guidelines = ["Bound log output by time, line count, and query.", "Redact common secrets and summarize repeated data instead of dumping huge logs."];
const LOG_ROOTS = ["/var/log", `${process.env.HOME ?? ""}/.local/state`, `${process.env.HOME ?? ""}/.cache`].filter(Boolean);
const bootSchema = Type.Union([
  Type.Integer({ minimum: -1000, maximum: 0 }),
  Type.String({ pattern: "^[0-9a-fA-F]{32}$" }),
]);

interface BootSession { offset: number; id: string; start: string; end: string }

async function readLogTail(input: string, maxBytes: number): Promise<{ path: string; text: string }> {
  const path = await resolveWithinRoots(input, LOG_ROOTS);
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Log path must resolve to a regular file");
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return { path, text: buffer.toString("utf8") };
  } finally { await handle.close(); }
}

function bootOperand(boot: unknown): string {
  if (Number.isInteger(boot) && Number(boot) >= -1000 && Number(boot) <= 0) return String(boot);
  if (typeof boot === "string" && /^[0-9a-fA-F]{32}$/.test(boot)) return boot;
  throw new Error("boot must be an offset from -1000 through 0 or a 32-character boot ID");
}

function parseBootSessions(output: string): BootSession[] {
  const sessions: BootSession[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(-?\d+)\s+([0-9a-fA-F]{32})\s+(.+?)\s+[—–]\s+(.+?)\s*$/);
    if (match) sessions.push({ offset: Number(match[1]), id: match[2]!, start: match[3]!, end: match[4]! });
  }
  return sessions;
}

async function loadBootSessions(count: number): Promise<{ sessions: BootSession[]; raw: string }> {
  const result = await runCommand({ command: "journalctl", args: ["--no-pager", "--list-boots"] }, { maxBuffer: 256 * 1024 });
  const parsed = parseBootSessions(result.stdout);
  return { sessions: parsed.slice(-count), raw: result.stdout };
}

const shutdownPatterns = /Reached target (?:System (?:Power Off|Reboot|Shutdown)|Shutdown)|systemd-shutdown.*(?:Syncing file systems|All filesystems unmounted|Powering off|Rebooting)|reboot: (?:Power down|Restarting system)|Powering off\.|Shutting down\./i;
const evidencePatterns: Array<[string, RegExp]> = [
  ["thermal", /thermal|overheat|critical temperature|temperature above threshold/i],
  ["watchdog_lockup_panic", /watchdog|soft lockup|hard lockup|kernel panic|not syncing|hung task/i],
  ["oom", /out of memory|oom-kill|oom_reaper|killed process \d+/i],
  ["hardware", /machine check|\bmce\b|\bedac\b|hardware error|corrected error|uncorrected error/i],
  ["storage_nvme", /\bnvme\b.*(?:error|reset|timeout|abort|failed)|I\/O error|blk_update_request|buffer i\/o/i],
  ["gpu", /(?:gpu|drm|nvrm|amdgpu|i915).*(?:hang|reset|fault|timeout|wedged|error)/i],
  ["power", /undervoltage|under-voltage|brownout|power failure|power loss|voltage.*(?:low|drop)/i],
];

export default function (pi: ExtensionAPI) {
  registerLinuxTool(pi, { name: "inspect_journal", label: "Inspect Journal", description: "Inspect bounded systemd journal output by boot and filters.", promptGuidelines: guidelines, parameters: Type.Object({ unit: Type.Optional(Type.String()), priority: Type.Optional(Type.String()), since: Type.Optional(Type.String()), until: Type.Optional(Type.String()), boot: Type.Optional(bootSchema), grep: Type.Optional(Type.String()), reverse: Type.Optional(Type.Boolean()), lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), async execute(_id: string, params: any) {
    const args = ["--no-pager", "-n", String(params.lines ?? 200), ...(params.unit ? [`--unit=${validateOperand(params.unit, "systemd unit")}`] : []), ...(params.priority ? [`--priority=${validateOperand(params.priority, "journal priority")}`] : []), ...(params.since ? [`--since=${validateOperand(params.since, "since value")}`] : []), ...(params.until ? [`--until=${validateOperand(params.until, "until value")}`] : []), ...(params.boot !== undefined ? [`--boot=${bootOperand(params.boot)}`] : []), ...(params.grep ? [`--grep=${validateOperand(params.grep, "journal grep")}`] : []), ...(params.reverse ? ["--reverse"] : [])];
    const r = await runCommand({ command: "journalctl", args }); return textResult(r.stdout || r.stderr, { args });
  }});
  registerLinuxTool(pi, { name: "list_boot_sessions", label: "List Boot Sessions", description: "List a bounded number of systemd journal boot sessions with offsets, IDs, and time ranges.", promptGuidelines: guidelines, parameters: Type.Object({ count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), async execute(_id: string, params: any) {
    const count = params.count ?? 20;
    const result = await loadBootSessions(count);
    const text = result.sessions.length > 0
      ? JSON.stringify({ sessions: result.sessions }, null, 2)
      : JSON.stringify({ sessions: [], note: "No parseable boot sessions were returned.", raw: result.raw.split(/\r?\n/).slice(-count) }, null, 2);
    return textResult(text, { count: result.sessions.length });
  }});
  registerLinuxTool(pi, { name: "diagnose_shutdowns", label: "Diagnose Shutdowns", description: "Inspect final journal lines from previous boots for clean shutdown markers and bounded crash evidence.", promptGuidelines: guidelines, parameters: Type.Object({ boots: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), lines: Type.Optional(Type.Integer({ minimum: 20, maximum: 1000 })) }), async execute(_id: string, params: any) {
    const bootCount = params.boots ?? 3;
    const lineCount = params.lines ?? 300;
    const listed = await loadBootSessions(100);
    const offsets = listed.sessions.filter(session => session.offset < 0).sort((a, b) => b.offset - a.offset).slice(0, bootCount);
    const selected = offsets.length > 0 ? offsets : Array.from({ length: bootCount }, (_, index) => ({ offset: -(index + 1), id: "unknown", start: "unknown", end: "unknown" }));
    const diagnoses = [] as Record<string, unknown>[];
    for (const session of selected) {
      try {
        const result = await runCommand({ command: "journalctl", args: ["--no-pager", `--boot=${session.offset}`, "-n", String(lineCount)] }, { maxBuffer: 512 * 1024 });
        const lines = result.stdout.split(/\r?\n/).filter(Boolean);
        const cleanShutdown = lines.some(line => shutdownPatterns.test(line));
        const evidence: Record<string, string[]> = {};
        for (const [category, pattern] of evidencePatterns) {
          const matches = lines.filter(line => pattern.test(line)).slice(-20).map(line => redactSecrets(line).slice(0, 1000));
          if (matches.length > 0) evidence[category] = matches;
        }
        diagnoses.push({ ...session, classification: cleanShutdown ? "clean shutdown markers found" : "possibly abrupt", clean_shutdown_markers: cleanShutdown, evidence });
      } catch (error: any) {
        diagnoses.push({ ...session, classification: "unavailable", error: String(error?.message ?? error).slice(0, 1000) });
      }
    }
    return textResult(preview(JSON.stringify({ diagnoses, note: "Missing clean shutdown markers are classified as possibly abrupt, not as definitive proof of an abrupt shutdown." }, null, 2), 20000), { boots: diagnoses.length, lines_per_boot: lineCount });
  }});
  registerLinuxTool(pi, { name: "inspect_log_file", label: "Inspect Log File", description: "Inspect a bounded preview of a log file under /var/log or user cache/state logs.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), max_chars: Type.Optional(Type.Number({ minimum: 100, maximum: 20000 })) }), async execute(_id: string, params: any) {
    const log = await readLogTail(params.path, params.max_chars ?? 8000);
    return textResult(preview(redactSecrets(log.text), params.max_chars ?? 8000), { path: log.path });
  }});
  registerLinuxTool(pi, { name: "search_logs", label: "Search Logs", description: "Search a bounded log file preview for text or regex.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), query: Type.String(), regex: Type.Optional(Type.Boolean()), max_matches: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })) }), async execute(_id: string, params: any) {
    const log = await readLogTail(params.path, 2 * 1024 * 1024);
    const lines = log.text.split(/\r?\n/); const re = params.regex ? new RegExp(params.query) : undefined; const matches = [] as string[];
    for (let i = 0; i < lines.length && matches.length < (params.max_matches ?? 50); i++) { const line = lines[i] ?? ""; if (re ? re.test(line) : line.includes(params.query)) matches.push(`${i + 1}: ${redactSecrets(line)}`); }
    return textResult(matches.join("\n") || "No matches", { path: log.path, matches: matches.length });
  }});
}
