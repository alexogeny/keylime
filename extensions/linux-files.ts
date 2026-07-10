import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { consumeOperationPlan, createOperationPlan, normalizeAbs, operationTarget, preview, registerLinuxTool, requireApproved, resolveSafeSystemPath, runCommand, sudoPrefix, textResult } from "./shared/linux-safety";

const guidelines = [
  "Only inspect or patch allowlisted system config paths.",
  "Use plan_system_file_patch before apply_system_file_patch.",
  "apply_system_file_patch creates a timestamped backup and preserves path in details.",
];

const VALIDATORS: Record<string, (target: string) => { command: string; args: string[] }> = {
  nginx: () => ({ command: "nginx", args: ["-t"] }),
  sshd: () => ({ command: "sshd", args: ["-t"] }),
  visudo: () => ({ command: "visudo", args: ["-c"] }),
  systemd_unit: target => ({ command: "systemd-analyze", args: ["verify", target] }),
};

async function assertSafe(p: string) {
  return resolveSafeSystemPath(p);
}
function sha(text: string) { return createHash("sha256").update(text).digest("hex"); }
function backupPath(file: string) { return `${file}.keylime-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`; }
function assertBackupForDestination(backup: string, destination: string) {
  const b = normalizeAbs(backup);
  const d = normalizeAbs(destination);
  if (!b.startsWith(`${d}.keylime-backup-`)) throw new Error("Backup path must be a Keylime backup for the destination");
  return b;
}
async function runValidator(name: string | undefined, target: string): Promise<string> {
  if (!name) return "";
  const build = VALIDATORS[name];
  if (!build) throw new Error(`Unknown validator preset: ${name}`);
  const spec = build(target);
  const r = await runCommand(spec);
  return [r.stdout, r.stderr].filter(Boolean).join("\n");
}

async function copyPreserving(ctx: any, source: string, destination: string): Promise<void> {
  try { await copyFile(source, destination); return; }
  catch (error: any) { if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error; }
  const spec = await sudoPrefix(ctx, { command: "cp", args: ["-a", "--", source, destination], sudo: true });
  await runCommand(spec);
}

async function installSystemText(ctx: any, target: string, text: string): Promise<void> {
  const localStage = `${target}.keylime-stage-${randomUUID()}`;
  try {
    await copyFile(target, localStage);
    await writeFile(localStage, text, "utf8");
    await rename(localStage, target);
    return;
  } catch (error: any) {
    await rm(localStage, { force: true }).catch(() => {});
    if (error?.code !== "EACCES" && error?.code !== "EPERM" && error?.code !== "EROFS") throw error;
  }
  const info = await stat(target);
  const dir = await mkdtemp(path.join(os.tmpdir(), "keylime-system-file-"));
  const staged = path.join(dir, "content");
  try {
    await writeFile(staged, text, { encoding: "utf8", mode: info.mode & 0o7777 });
    const spec = await sudoPrefix(ctx, { command: "install", args: ["--owner", String(info.uid), "--group", String(info.gid), "--mode", (info.mode & 0o7777).toString(8), "--", staged, target], sudo: true });
    await runCommand(spec);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export default function (pi: ExtensionAPI) {
  registerLinuxTool(pi, { name: "inspect_system_file", label: "Inspect System File", description: "Read a bounded preview of an allowlisted system config file.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), max_chars: Type.Optional(Type.Number({ minimum: 100, maximum: 20000 })) }), async execute(_id: string, params: any) {
    const target = await assertSafe(params.path); const buf = await readFile(target, "utf8");
    return textResult(preview(buf, params.max_chars ?? 8000), { path: target, sha256: sha(buf), bytes: Buffer.byteLength(buf) });
  }});
  registerLinuxTool(pi, { name: "backup_system_file", label: "Backup System File", description: "Create a timestamped backup beside an allowlisted system config file.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const target = await assertSafe(params.path); const backup = backupPath(target); await requireApproved(ctx, "Back up system file", `${target} -> ${backup}`); await copyPreserving(ctx, target, backup);
    return textResult(`Backed up ${target} -> ${backup}`, { path: target, backup });
  }});
  registerLinuxTool(pi, { name: "restore_system_file_backup", label: "Restore System File Backup", description: "Restore a destination-derived Keylime system file backup after confirmation.", promptGuidelines: guidelines, parameters: Type.Object({ backup: Type.String(), destination: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const dest = await assertSafe(params.destination); const backup = assertBackupForDestination(params.backup, dest);
    await requireApproved(ctx, "Restore system file backup", `${backup} -> ${dest}`); const content = await readFile(backup, "utf8"); await installSystemText(ctx, dest, content);
    return textResult(`Restored ${dest} from ${backup}`, { backup, destination: dest });
  }});
  registerLinuxTool(pi, { name: "plan_system_file_patch", label: "Plan System File Patch", description: "Plan an exact text replacement for an allowlisted system config file.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String(), expected_replacements: Type.Optional(Type.Number({ minimum: 1 })) }), async execute(_id: string, params: any) {
    const target = await assertSafe(params.path); const text = await readFile(target, "utf8"); const count = text.split(params.oldText).length - 1;
    if (count === 0) throw new Error("oldText not found"); if (params.expected_replacements !== undefined && count !== params.expected_replacements) throw new Error(`Expected ${params.expected_replacements} replacements, found ${count}`);
    const checksum = sha(text); const plan = createOperationPlan("system-file-patch", operationTarget({ path: target, oldText: params.oldText, newText: params.newText, replacements: count, sha256: checksum }));
    return textResult(`Plan: replace ${count} occurrence(s) in ${target}\n--- old ---\n${preview(params.oldText, 2000)}\n--- new ---\n${preview(params.newText, 2000)}`, { path: target, replacements: count, sha256: checksum, plan_token: plan.planToken, expires_at: plan.expiresAt });
  }});
  registerLinuxTool(pi, { name: "apply_system_file_patch", label: "Apply System File Patch", description: "Apply an exact system config replacement with count guard, backup, and optional validator preset.", promptGuidelines: [...guidelines, "Requires prior plan review; creates backup before writing; rolls back if validation fails."], parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String(), expected_replacements: Type.Number({ minimum: 1 }), expected_sha256: Type.Optional(Type.String()), plan_token: Type.String(), validator: Type.Optional(Type.Union([Type.Literal("nginx"), Type.Literal("sshd"), Type.Literal("visudo"), Type.Literal("systemd_unit")])) }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const target = await assertSafe(params.path); const text = await readFile(target, "utf8"); if (params.expected_sha256 && sha(text) !== params.expected_sha256) throw new Error("Checksum mismatch");
    const count = text.split(params.oldText).length - 1; if (count !== params.expected_replacements) throw new Error(`Expected ${params.expected_replacements} replacements, found ${count}`);
    consumeOperationPlan(params.plan_token, "system-file-patch", operationTarget({ path: target, oldText: params.oldText, newText: params.newText, replacements: count, sha256: sha(text) }));
    await requireApproved(ctx, "Apply system file patch", `${target}: ${count} replacement(s), backup will be created`);
    const backup = backupPath(target); await copyPreserving(ctx, target, backup); await installSystemText(ctx, target, text.split(params.oldText).join(params.newText));
    try {
      const validation = await runValidator(params.validator, target);
      return textResult(`Patched ${target}; backup: ${backup}${validation ? `\nValidation:\n${validation}` : ""}`, { path: target, backup, replacements: count });
    } catch (error: any) {
      const original = await readFile(backup, "utf8"); await installSystemText(ctx, target, original);
      throw new Error(`Validation failed; restored ${target} from ${backup}: ${error.message ?? error}`);
    }
  }});
  registerLinuxTool(pi, { name: "validate_config", label: "Validate Config", description: "Run an allowlisted config validator preset against a target config path.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), validator: Type.Union([Type.Literal("nginx"), Type.Literal("sshd"), Type.Literal("visudo"), Type.Literal("systemd_unit")]) }), async execute(_id: string, params: any) {
    const target = await assertSafe(params.path); const validation = await runValidator(params.validator, target);
    return textResult(validation || "Validation command completed", { path: target, validator: params.validator });
  }});
}
