import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultCheckCommands, detectProjectKind, type CheckSuite } from "./shared/test-runner";

const execFileAsync = promisify(execFile);

async function rootFiles(cwd: string): Promise<string[]> {
  try { return await readdir(cwd); }
  catch { return []; }
}

export default function testRunnerExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_checks",
    label: "Run Checks",
    description: "Run project tests/typechecks/lints using detected defaults or a custom command.",
    promptSnippet: "Run tests or type checks",
    promptGuidelines: ["Use after code edits to verify behavior."],
    parameters: Type.Object({
      suite: Type.Optional(StringEnum(["all", "test", "typecheck", "lint"] as const, { description: "Check suite" })),
      command: Type.Optional(Type.String({ description: "Custom command" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Custom args" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const commands = params.command
        ? [{ command: params.command, args: params.args ?? [], label: [params.command, ...(params.args ?? [])].join(" ") }]
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
          results.push({ ...cmd, ok: true, stdout: result.stdout, stderr: result.stderr });
        } catch (err: any) {
          results.push({ ...cmd, ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "", code: err.code });
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
