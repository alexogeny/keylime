import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { customCheckCommand, defaultCheckCommands, detectProjectKind, type CheckSuite } from "./shared/test-runner";
import { isCapabilityActive } from "./shared/intent";
import { runChecksCommandBlockReason } from "./shared/safety-policy";
import { headTail } from "./shared/output-preview";
export { runChecksCommandBlockReason } from "./shared/safety-policy";

const execFileAsync = promisify(execFile);
const CHECK_STREAM_PREVIEW_CHARS = 3000;

export function summarizeCheckStream(text: string, maxChars = CHECK_STREAM_PREVIEW_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const interesting = trimmed
    .split(/\r?\n/)
    .filter(line => /fail|error|exception|trace|warning|denied|blocked|expected|received|panic|assert/i.test(line))
    .slice(0, 12);
  const preview = headTail(trimmed, maxChars, `… [run_checks output truncated: ${trimmed.length - maxChars} chars removed] …`);
  return [
    `Output summarized (${trimmed.length} chars).`,
    interesting.length ? `Key lines:\n${interesting.join("\n")}` : "",
    `Preview:\n${preview}`,
  ].filter(Boolean).join("\n");
}

function stringEnum<const T extends readonly string[]>(values: T, options?: Record<string, unknown>) {
  return Type.Union(values.map(value => Type.Literal(value)), options);
}

async function rootFiles(cwd: string): Promise<string[]> {
  try {
    const root = await readdir(cwd);
    const extensions = await readdir(`${cwd}/extensions`).catch(() => []);
    return [...root, ...extensions.map(file => `extensions/${file}`)];
  } catch { return []; }
}

export default function testRunnerExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_checks",
    label: "Run Checks",
    description: "Run project tests/typechecks/lints using detected defaults or a custom command.",
    promptSnippet: "Run tests or type checks",
    promptGuidelines: [
      "Use after code edits to verify behavior.",
      "Prefer run_checks over bash for tests, type checks, and lint checks.",
      "Use custom command/args when the default suite cannot express the check.",
    ],
    parameters: Type.Object({
      suite: Type.Optional(stringEnum(["all", "test", "typecheck", "lint"] as const, { description: "Check suite" })),
      command: Type.Optional(Type.String({ description: "Custom command" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Custom args" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      if (params.command && isCapabilityActive("coding")) {
        const blocked = runChecksCommandBlockReason(params.command, params.args ?? []);
        if (blocked) throw new Error(`run_checks blocked custom command in coding mode: ${blocked}`);
      }

      const commands = params.command
        ? [customCheckCommand(params.command, params.args)]
        : defaultCheckCommands(detectProjectKind(await rootFiles(ctx.cwd)), (params.suite ?? "all") as CheckSuite);

      if (commands.length === 0) throw new Error("No default check command for this project/suite; provide command + args.");

      const results = [];
      for (const cmd of commands) {
        onUpdate?.({ content: [{ type: "text", text: `Running ${cmd.label}…` }] });
        try {
          const result = await execFileAsync(cmd.command, cmd.args, {
            cwd: ctx.cwd,
            timeout: params.timeout_ms ?? 120_000,
            maxBuffer: 1024 * 1024,
          });
          results.push({ ...cmd, ok: true, stdout: summarizeCheckStream(result.stdout), stderr: summarizeCheckStream(result.stderr) });
        } catch (err: any) {
          const stderr = typeof err.stderr === "string" && err.stderr.trim() ? err.stderr : err.message ?? "";
          results.push({ ...cmd, ok: false, stdout: summarizeCheckStream(err.stdout ?? ""), stderr: summarizeCheckStream(stderr), code: err.code });
          break;
        }
      }

      const text = results.map(r => [
        `${r.ok ? "✓" : "✗"} ${r.label}`,
        r.stdout?.trim() ? `stdout:\n${r.stdout.trim()}` : "",
        r.stderr?.trim() ? `stderr:\n${r.stderr.trim()}` : "",
      ].filter(Boolean).join("\n")).join("\n\n");

      return { content: [{ type: "text", text }], details: { results }, isError: results.some(r => !r.ok) };
    },
  });
}
