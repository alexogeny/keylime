import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { commandAvailable, runCommand, textResult } from "./shared/linux-safety";

const guidelines = [
  "Use plan_*_profile first; profiling executes project code and may be slow.",
  "Commands are preset/argv only; no shell strings.",
  "Keep timeouts bounded and store generated artifacts under .pi/profiles.",
];

const argArray = Type.Optional(Type.Array(Type.String(), { maxItems: 80 }));
const timeoutParam = Type.Optional(Type.Number({ minimum: 1000, maximum: 600000, description: "Timeout ms" }));

export type ProfilePlan = { command: string; args: string[]; artifact?: string; cwd?: string };

type Lang = "python" | "typescript" | "rust";
function safeRel(input: string, label = "path"): string {
  if (!input || input.startsWith("-") || path.isAbsolute(input) || input.split(/[\\/]+/).includes("..")) throw new Error(`Unsafe ${label}: ${input}`);
  return input;
}
function safeArgs(args: string[] = []): string[] {
  for (const arg of args) {
    if (arg.includes("\0")) throw new Error("NUL bytes are not allowed in args");
  }
  return args;
}
async function ensureProfileDir(cwd: string, lang: Lang): Promise<string> {
  const dir = path.join(cwd, ".pi", "profiles", lang);
  await mkdir(dir, { recursive: true });
  return dir;
}
function stamp(): string { return new Date().toISOString().replace(/[:.]/g, "-"); }
function renderPlan(plan: ProfilePlan): string {
  return [`Plan: ${[plan.command, ...plan.args].join(" ")}`, plan.artifact ? `Artifact: ${plan.artifact}` : ""].filter(Boolean).join("\n");
}
async function runPlan(plan: ProfilePlan, timeoutMs: number) {
  const r = await runCommand({ command: plan.command, args: plan.args, cwd: plan.cwd }, { timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  return [r.stdout, r.stderr].filter(Boolean).join("\n") || "Profile command completed";
}

export function buildPythonProfilePlan(params: any, cwd: string): ProfilePlan {
  const python = params.python ?? "python3";
  const sort = params.sort ?? "cumtime";
  const args = safeArgs(params.args ?? []);
  const output = params.output ? safeRel(params.output, "output") : undefined;
  const base = ["-m", "cProfile", "-s", sort, ...(output ? ["-o", output] : [])];
  if (params.mode === "module") return { command: python, args: [...base, "-m", params.module, ...args], artifact: output, cwd };
  if (params.mode === "pytest") return { command: python, args: [...base, "-m", "pytest", ...args], artifact: output, cwd };
  return { command: python, args: [...base, safeRel(params.path, "script"), ...args], artifact: output, cwd };
}

export function buildTypescriptProfilePlan(params: any, cwd: string): ProfilePlan {
  const runtime = params.runtime ?? "bun";
  const args = safeArgs(params.args ?? []);
  const mode = params.mode ?? "file";
  if (runtime === "node" && params.cpu_profile === true) {
    const dir = params.output_dir ? safeRel(params.output_dir, "output_dir") : `.pi/profiles/typescript`;
    const target = mode === "package_script" ? [safeRel(params.script, "script")] : [safeRel(params.path, "file")];
    const nodeArgs = ["--cpu-prof", "--cpu-prof-dir", dir, ...(mode === "package_script" ? [] : target), ...args];
    if (mode === "package_script") throw new Error("node CPU profile mode requires a file path, not package_script");
    return { command: "node", args: nodeArgs, artifact: dir, cwd };
  }
  if (mode === "package_script") return { command: runtime, args: ["run", safeRel(params.script, "script"), ...args], cwd };
  return { command: runtime, args: [safeRel(params.path, "file"), ...args], cwd };
}

export function buildRustProfilePlan(params: any, cwd: string): ProfilePlan {
  const args = safeArgs(params.args ?? []);
  const mode = params.mode ?? "test";
  if (mode === "flamegraph") return { command: "cargo", args: ["flamegraph", ...args], artifact: "flamegraph.svg", cwd };
  if (mode === "bench") return { command: "cargo", args: ["bench", ...args], cwd };
  if (mode === "run") return { command: "cargo", args: ["run", "--release", ...(params.bin ? ["--bin", safeRel(params.bin, "bin")] : []), ...(args.length ? ["--", ...args] : [])], cwd };
  return { command: "cargo", args: ["test", "--release", ...args], cwd };
}

export default function profilingTools(pi: ExtensionAPI) {
  pi.registerTool({ name: "inspect_profiler_availability", label: "Inspect Profiler Availability", description: "Check local profiler/runtime tool availability for Python, TypeScript, and Rust.", promptGuidelines: guidelines, parameters: Type.Object({}), async execute(_id: string) {
    const names = ["python3", "python", "pytest", "node", "bun", "cargo", "perf", "cargo-flamegraph", "hyperfine"];
    const rows = await Promise.all(names.map(async name => `${name}: ${(await commandAvailable(name)) ? "yes" : "no"}`));
    return textResult(rows.join("\n"));
  }});

  pi.registerTool({ name: "plan_python_profile", label: "Plan Python Profile", description: "Build a cProfile command plan for a Python script/module/pytest run.", promptGuidelines: guidelines, parameters: Type.Object({ mode: Type.Union([Type.Literal("script"), Type.Literal("module"), Type.Literal("pytest")]), path: Type.Optional(Type.String()), module: Type.Optional(Type.String()), args: argArray, sort: Type.Optional(Type.String()), output: Type.Optional(Type.String()), python: Type.Optional(Type.String()) }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const plan = buildPythonProfilePlan(params, ctx.cwd); return textResult(renderPlan(plan), { plan });
  }});
  pi.registerTool({ name: "run_python_profile", label: "Run Python Profile", description: "Run a planned Python cProfile profile command with bounded output.", promptGuidelines: guidelines, parameters: Type.Object({ mode: Type.Union([Type.Literal("script"), Type.Literal("module"), Type.Literal("pytest")]), path: Type.Optional(Type.String()), module: Type.Optional(Type.String()), args: argArray, sort: Type.Optional(Type.String()), output: Type.Optional(Type.String()), python: Type.Optional(Type.String()), timeout_ms: timeoutParam }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const plan = buildPythonProfilePlan(params, ctx.cwd); const out = await runPlan(plan, params.timeout_ms ?? 120000); return textResult(`${renderPlan(plan)}\n\n${out}`, { plan });
  }});

  pi.registerTool({ name: "plan_typescript_profile", label: "Plan TypeScript Profile", description: "Build a Bun/Node profiling command plan for a TypeScript/JavaScript entrypoint or package script.", promptGuidelines: guidelines, parameters: Type.Object({ runtime: Type.Optional(Type.Union([Type.Literal("bun"), Type.Literal("node")])), mode: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("package_script")])), path: Type.Optional(Type.String()), script: Type.Optional(Type.String()), args: argArray, cpu_profile: Type.Optional(Type.Boolean()), output_dir: Type.Optional(Type.String()) }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const plan = buildTypescriptProfilePlan(params, ctx.cwd); return textResult(renderPlan(plan), { plan });
  }});
  pi.registerTool({ name: "run_typescript_profile", label: "Run TypeScript Profile", description: "Run a planned Bun/Node TypeScript/JavaScript profile with bounded output.", promptGuidelines: guidelines, parameters: Type.Object({ runtime: Type.Optional(Type.Union([Type.Literal("bun"), Type.Literal("node")])), mode: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("package_script")])), path: Type.Optional(Type.String()), script: Type.Optional(Type.String()), args: argArray, cpu_profile: Type.Optional(Type.Boolean()), output_dir: Type.Optional(Type.String()), timeout_ms: timeoutParam }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    if (params.output_dir) await mkdir(path.join(ctx.cwd, safeRel(params.output_dir, "output_dir")), { recursive: true });
    else if (params.cpu_profile) await ensureProfileDir(ctx.cwd, "typescript");
    const plan = buildTypescriptProfilePlan(params, ctx.cwd); const out = await runPlan(plan, params.timeout_ms ?? 120000); return textResult(`${renderPlan(plan)}\n\n${out}`, { plan });
  }});

  pi.registerTool({ name: "plan_rust_profile", label: "Plan Rust Profile", description: "Build a Cargo profiling command plan for tests, benches, release runs, or flamegraph.", promptGuidelines: guidelines, parameters: Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("test"), Type.Literal("bench"), Type.Literal("run"), Type.Literal("flamegraph")])), bin: Type.Optional(Type.String()), args: argArray }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const plan = buildRustProfilePlan(params, ctx.cwd); return textResult(renderPlan(plan), { plan });
  }});
  pi.registerTool({ name: "run_rust_profile", label: "Run Rust Profile", description: "Run a planned Cargo profiling command with bounded output.", promptGuidelines: guidelines, parameters: Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("test"), Type.Literal("bench"), Type.Literal("run"), Type.Literal("flamegraph")])), bin: Type.Optional(Type.String()), args: argArray, timeout_ms: timeoutParam }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const plan = buildRustProfilePlan(params, ctx.cwd); const out = await runPlan(plan, params.timeout_ms ?? 300000); return textResult(`${renderPlan(plan)}\n\n${out}`, { plan });
  }});

  pi.registerTool({ name: "inspect_profile_artifact", label: "Inspect Profile Artifact", description: "Inspect metadata for a generated profile artifact under .pi/profiles.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const rel = safeRel(params.path); if (!rel.startsWith(".pi/profiles/")) throw new Error("Profile artifacts must live under .pi/profiles");
    const s = await stat(path.join(ctx.cwd, rel));
    return textResult(`${rel}\nsize=${s.size}\nmtime=${s.mtime.toISOString()}`, { path: rel, size: s.size });
  }});
}
