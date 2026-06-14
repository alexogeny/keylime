import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isSafeSystemPath, normalizeAbs, preview, requireApproved, runCommand, textResult } from "./shared/linux-safety";

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

function assertSafe(p: string) {
  if (!isSafeSystemPath(p)) throw new Error(`Unsafe system file path: ${p}`);
  return normalizeAbs(p);
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "inspect_system_file", label: "Inspect System File", description: "Read a bounded preview of an allowlisted system config file.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), max_chars: Type.Optional(Type.Number({ minimum: 100, maximum: 20000 })) }), async execute(_id: string, params: any) {
    const target = assertSafe(params.path); const buf = await readFile(target, "utf8");
    return textResult(preview(buf, params.max_chars ?? 8000), { path: target, sha256: sha(buf), bytes: Buffer.byteLength(buf) });
  }});
  pi.registerTool({ name: "backup_system_file", label: "Backup System File", description: "Create a timestamped backup beside an allowlisted system config file.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String() }), async execute(_id: string, params: any) {
    const target = assertSafe(params.path); const backup = backupPath(target); await copyFile(target, backup);
    return textResult(`Backed up ${target} -> ${backup}`, { path: target, backup });
  }});
  pi.registerTool({ name: "restore_system_file_backup", label: "Restore System File Backup", description: "Restore a destination-derived Keylime system file backup after confirmation.", promptGuidelines: guidelines, parameters: Type.Object({ backup: Type.String(), destination: Type.String() }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const dest = assertSafe(params.destination); const backup = assertBackupForDestination(params.backup, dest);
    await requireApproved(ctx, "Restore system file backup", `${backup} -> ${dest}`); await copyFile(backup, dest);
    return textResult(`Restored ${dest} from ${backup}`, { backup, destination: dest });
  }});
  pi.registerTool({ name: "plan_system_file_patch", label: "Plan System File Patch", description: "Plan an exact text replacement for an allowlisted system config file.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String(), expected_replacements: Type.Optional(Type.Number({ minimum: 1 })) }), async execute(_id: string, params: any) {
    const target = assertSafe(params.path); const text = await readFile(target, "utf8"); const count = text.split(params.oldText).length - 1;
    if (count === 0) throw new Error("oldText not found"); if (params.expected_replacements !== undefined && count !== params.expected_replacements) throw new Error(`Expected ${params.expected_replacements} replacements, found ${count}`);
    return textResult(`Plan: replace ${count} occurrence(s) in ${target}\n--- old ---\n${preview(params.oldText, 2000)}\n--- new ---\n${preview(params.newText, 2000)}`, { path: target, replacements: count, sha256: sha(text) });
  }});
  pi.registerTool({ name: "apply_system_file_patch", label: "Apply System File Patch", description: "Apply an exact system config replacement with count guard, backup, and optional validator preset.", promptGuidelines: [...guidelines, "Requires prior plan review; creates backup before writing; rolls back if validation fails."], parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String(), expected_replacements: Type.Number({ minimum: 1 }), expected_sha256: Type.Optional(Type.String()), validator: Type.Optional(Type.Union([Type.Literal("nginx"), Type.Literal("sshd"), Type.Literal("visudo"), Type.Literal("systemd_unit")])) }), async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
    const target = assertSafe(params.path); const text = await readFile(target, "utf8"); if (params.expected_sha256 && sha(text) !== params.expected_sha256) throw new Error("Checksum mismatch");
    const count = text.split(params.oldText).length - 1; if (count !== params.expected_replacements) throw new Error(`Expected ${params.expected_replacements} replacements, found ${count}`);
    await requireApproved(ctx, "Apply system file patch", `${target}: ${count} replacement(s), backup will be created`);
    const backup = backupPath(target); await copyFile(target, backup); await writeFile(target, text.split(params.oldText).join(params.newText), "utf8");
    try {
      const validation = await runValidator(params.validator, target);
      return textResult(`Patched ${target}; backup: ${backup}${validation ? `\nValidation:\n${validation}` : ""}`, { path: target, backup, replacements: count });
    } catch (error: any) {
      await copyFile(backup, target);
      throw new Error(`Validation failed; restored ${target} from ${backup}: ${error.message ?? error}`);
    }
  }});
  pi.registerTool({ name: "validate_config", label: "Validate Config", description: "Run an allowlisted config validator preset against a target config path.", promptGuidelines: guidelines, parameters: Type.Object({ path: Type.String(), validator: Type.Union([Type.Literal("nginx"), Type.Literal("sshd"), Type.Literal("visudo"), Type.Literal("systemd_unit")]) }), async execute(_id: string, params: any) {
    const target = assertSafe(params.path); const validation = await runValidator(params.validator, target);
    return textResult(validation || "Validation command completed", { path: target, validator: params.validator });
  }});
}
