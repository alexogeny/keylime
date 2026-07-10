import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { open } from "node:fs/promises";
import { preview, redactSecrets, registerLinuxTool, resolveWithinRoots, runCommand, textResult, validateOperand } from "./shared/linux-safety";

const guidelines = ["Bound log output by time, line count, and query.", "Redact common secrets and summarize repeated data instead of dumping huge logs."];
const LOG_ROOTS = ["/var/log", `${process.env.HOME ?? ""}/.local/state`, `${process.env.HOME ?? ""}/.cache`].filter(Boolean);

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

export default function (pi: ExtensionAPI) {
  registerLinuxTool(pi, { name: "inspect_journal", label: "Inspect Journal", description: "Inspect bounded systemd journal output.", promptGuidelines: guidelines, parameters: Type.Object({ unit: Type.Optional(Type.String()), priority: Type.Optional(Type.String()), since: Type.Optional(Type.String()), lines: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })) }), async execute(_id: string, params: any) {
    const args = ["--no-pager", "-n", String(params.lines ?? 200), ...(params.unit ? ["-u", validateOperand(params.unit, "systemd unit")] : []), ...(params.priority ? ["-p", validateOperand(params.priority, "journal priority")] : []), ...(params.since ? ["--since", validateOperand(params.since, "since value")] : [])];
    const r = await runCommand({ command: "journalctl", args }); return textResult(r.stdout || r.stderr, { args });
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
