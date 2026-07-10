import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { isCapabilityActive } from "./intent";

const execFileAsync = promisify(execFile);

export type CommandSpec = { command: string; args: string[]; label?: string; sudo?: boolean; stdin?: string; cwd?: string };

type OperationPlan = { kind: string; target: string; expiresAt: number };
const operationPlans = new Map<string, OperationPlan>();
const PLAN_TTL_MS = 10 * 60 * 1000;

export function requireLinuxCapability(): void {
  if (!isCapabilityActive("linux")) throw new Error("This tool requires active linux_ops/linux capability routing.");
}

export function registerLinuxTool(pi: any, definition: any): void {
  const execute = definition.execute;
  pi.registerTool({
    ...definition,
    async execute(...args: any[]) {
      requireLinuxCapability();
      return execute(...args);
    },
  });
}

export function createOperationPlan(kind: string, target: string): { planToken: string; expiresAt: string } {
  const now = Date.now();
  for (const [token, plan] of operationPlans) if (plan.expiresAt <= now) operationPlans.delete(token);
  while (operationPlans.size >= 256) operationPlans.delete(operationPlans.keys().next().value as string);
  const planToken = randomUUID();
  const expiresAt = now + PLAN_TTL_MS;
  operationPlans.set(planToken, { kind, target, expiresAt });
  return { planToken, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeOperationPlan(planToken: string, kind: string, target: string): void {
  const plan = operationPlans.get(planToken);
  operationPlans.delete(planToken);
  if (!plan) throw new Error("A valid plan_token from the matching plan tool is required");
  if (plan.expiresAt <= Date.now()) throw new Error("The operation plan has expired; run the plan tool again");
  if (plan.kind !== kind || plan.target !== target) throw new Error("The operation plan does not match this request");
}

export function operationTarget(value: unknown): string {
  return JSON.stringify(value);
}

export function validateOperand(value: string, label: string): string {
  if (!value || value.length > 500 || /[\0\r\n]/.test(value) || value.startsWith("-")) throw new Error(`Invalid ${label}`);
  return value;
}

export function validateSignal(value = "TERM"): string {
  const signal = value.toUpperCase().replace(/^SIG/, "");
  if (!new Set(["TERM", "INT", "HUP", "QUIT", "USR1", "USR2", "STOP", "CONT", "KILL"]).has(signal)) throw new Error("Unsupported process signal");
  return signal;
}

export function validateMode(value: string): string {
  if (!/^(?:[0-7]{3,4}|[ugoa]*[+=-][rwxXstugo]+(?:,[ugoa]*[+=-][rwxXstugo]+)*)$/.test(value)) throw new Error("Invalid chmod mode");
  return value;
}

export function validateHttpUrl(value: string): string {
  if (value.length > 2000 || /[\0\r\n]/.test(value)) throw new Error("Invalid URL");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported");
  return parsed.toString();
}

export async function resolveWithinRoots(input: string, roots: string[]): Promise<string> {
  const target = await realpath(normalizeAbs(input));
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(normalizeAbs(root));
      if (target === resolvedRoot || target.startsWith(`${resolvedRoot}${path.sep}`)) return target;
    } catch {}
  }
  throw new Error(`Path is outside the allowed roots: ${target}`);
}

export async function resolveSafeSystemPath(input: string): Promise<string> {
  const target = await realpath(normalizeAbs(input));
  if (!isSafeSystemPath(target)) throw new Error(`Unsafe system file path: ${target}`);
  return target;
}

export const SYSTEM_FILE_ALLOW_PREFIXES = [
  "/etc/",
  "/usr/local/etc/",
  `${process.env.HOME ?? ""}/.config/`,
].filter(Boolean);

export const SYSTEM_FILE_DENY_PREFIXES = ["/usr/bin/", "/bin/", "/sbin/", "/usr/sbin/", "/boot/", "/proc/", "/sys/", "/dev/", "/run/"];
export const CRITICAL_UNITS = new Set(["sshd", "ssh", "systemd-networkd", "NetworkManager", "display-manager", "gdm", "sddm", "lightdm", "multi-user.target", "graphical.target"]);
export const CRITICAL_PATHS = new Set(["/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/var", "/home"]);

export function normalizeAbs(input: string): string {
  if (!input) throw new Error("Path is required");
  return path.resolve(input);
}

export function isSafeSystemPath(input: string): boolean {
  const target = normalizeAbs(input);
  if (SYSTEM_FILE_DENY_PREFIXES.some(prefix => target === prefix.slice(0, -1) || target.startsWith(prefix))) return false;
  return SYSTEM_FILE_ALLOW_PREFIXES.some(prefix => target.startsWith(prefix));
}

export function denylistedSystemdUnit(unit: string): string | undefined {
  const base = unit.replace(/\.(service|socket|timer|target)$/i, "");
  if (CRITICAL_UNITS.has(base) || CRITICAL_UNITS.has(unit)) return `${unit} is a critical unit; ask for explicit manual confirmation outside automation.`;
  return undefined;
}

export function riskyFilesystemTarget(input: string): string | undefined {
  const target = normalizeAbs(input);
  if (CRITICAL_PATHS.has(target)) return `refusing broad filesystem target: ${target}`;
  if (["/proc", "/sys", "/dev", "/run"].some(p => target === p || target.startsWith(`${p}/`))) return `refusing virtual/system target: ${target}`;
  return undefined;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(password|passwd|token|secret|api[_-]?key)=\S+/gi, "$1=<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>");
}

export function preview(text: string, max = 6000): string {
  const clean = redactSecrets(text.trim());
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.floor(max / 2))}\n… truncated …\n${clean.slice(-Math.floor(max / 2))}`;
}

export async function runCommand(spec: CommandSpec, options: { timeoutMs?: number; maxBuffer?: number } = {}) {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timeout = setTimeout(() => {
    if (!settled) child.kill("SIGTERM");
  }, options.timeoutMs ?? 15_000);

  child.stdout.on("data", chunk => {
    if (stdout.length < maxBuffer) stdout += String(chunk);
  });
  child.stderr.on("data", chunk => {
    if (stderr.length < maxBuffer) stderr += String(chunk);
  });
  if (spec.stdin) child.stdin.end(spec.stdin);
  else child.stdin.end();

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => { settled = true; clearTimeout(timeout); });

  if (code !== 0) {
    const error = new Error(`${spec.command} exited with ${code}: ${preview(stderr || stdout, 2000)}`) as Error & { stdout?: string; stderr?: string; code?: number | null };
    error.stdout = preview(stdout);
    error.stderr = preview(stderr);
    error.code = code;
    throw error;
  }
  return { stdout: preview(stdout), stderr: preview(stderr) };
}

export async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function requireApproved(ctx: any, title: string, message: string): Promise<void> {
  if (!ctx?.ui?.confirm) return;
  const ok = await ctx.ui.confirm(title, message, { timeout: 30_000 });
  if (!ok) throw new Error("Operation cancelled by user");
}

export async function sudoPrefix(ctx: any, spec: CommandSpec): Promise<CommandSpec> {
  if (!spec.sudo) return spec;
  const password = ctx?.ui?.input ? await ctx.ui.input("sudo password", `Review: ${spec.command} ${spec.args.join(" ")}`) : undefined;
  if (!password) throw new Error("sudo password required");
  return { command: "sudo", args: ["-S", "-p", "", spec.command, ...spec.args], label: spec.label, sudo: false, stdin: `${password}\n` };
}

export function textResult(text: string, details?: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text", text }], details, isError };
}
