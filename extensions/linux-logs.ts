import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { preview, redactSecrets, runCommand, textResult } from "./shared/linux-safety";

const guidelines = ["Bound log output by time, line count, and query.", "Redact common secrets and summarize repeated data instead of dumping huge logs."];

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "inspect_journal", label: "Inspect Journal", description: "Inspect bounded systemd journal output.", promptGuidelines: guidelines, parameters: Type.Object({ unit: Type.Optional(Type.String()), priority: Type.Optional(Type.String()), since: Type.Optional(Type.String()), lines: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })) }), async execute(_id: string, params: any) {
    const args = ["--no-pager", "-n", String(params.lines ?? 200), ...(params.unit ? ["-u", params.unit] : []), ...(params.priority ? ["-p", params.priority] : []), ...(params.since ? ["--since", params.since] : [])];
    const r = await runCommand({ command: "journalctl", args }); return textResult(r.stdout || r.stderr, { args });
  }});
  pi.registerTool({ name: "inspect_log_file", label: "Inspect Log File", description: "Inspect a bounded preview of a log file under /var/log or user cache/state logs.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), max_chars: Type.Optional(Type.Number({ minimum: 100, maximum: 20000 })) }), async execute(_id: string, params: any) {
    const p = params.path; if (!p.startsWith("/var/log/") && !p.includes("/.local/state/") && !p.includes("/.cache/")) throw new Error("Log path must be under /var/log, ~/.local/state, or ~/.cache");
    return textResult(preview(await readFile(p, "utf8"), params.max_chars ?? 8000), { path: p });
  }});
  pi.registerTool({ name: "search_logs", label: "Search Logs", description: "Search a bounded log file preview for text or regex.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), query: Type.String(), regex: Type.Optional(Type.Boolean()), max_matches: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })) }), async execute(_id: string, params: any) {
    const p = params.path; if (!p.startsWith("/var/log/") && !p.includes("/.local/state/") && !p.includes("/.cache/")) throw new Error("Log path must be under /var/log, ~/.local/state, or ~/.cache");
    const lines = (await readFile(p, "utf8")).split(/\r?\n/); const re = params.regex ? new RegExp(params.query) : undefined; const matches = [] as string[];
    for (let i = 0; i < lines.length && matches.length < (params.max_matches ?? 50); i++) { const line = lines[i] ?? ""; if (re ? re.test(line) : line.includes(params.query)) matches.push(`${i + 1}: ${redactSecrets(line)}`); }
    return textResult(matches.join("\n") || "No matches", { path: p, matches: matches.length });
  }});
}
