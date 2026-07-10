import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import linuxPackages from "../extensions/linux-packages";
import linuxSystemd from "../extensions/linux-systemd";
import linuxFiles from "../extensions/linux-files";
import linuxHardware from "../extensions/linux-hardware";
import linuxLogs from "../extensions/linux-logs";
import linuxNetwork from "../extensions/linux-network";
import linuxFilesystem from "../extensions/linux-filesystem";
import linuxUsers from "../extensions/linux-users";
import linuxProcesses from "../extensions/linux-processes";
import linuxChecks from "../extensions/linux-checks";
import linuxDiagnostics from "../extensions/linux-diagnostics";
import linuxDiscovery from "../extensions/linux-discovery";
import { consumeOperationPlan, createOperationPlan, isSafeSystemPath, denylistedSystemdUnit, operationTarget, resolveWithinRoots, riskyFilesystemTarget, sudoPrefix, validateHttpUrl, validateMode, validateOperand, validateSignal } from "../extensions/shared/linux-safety";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";
import { mockPiFixture } from "./helpers/mock-pi";

function registerAll() {
  setCurrentRoute(classifyIntent("linux systemd apt pacman logs filesystem network diagnostics"));
  const harness = mockPiFixture();
  linuxPackages(harness.pi);
  linuxSystemd(harness.pi);
  linuxFiles(harness.pi);
  linuxHardware(harness.pi);
  linuxLogs(harness.pi);
  linuxNetwork(harness.pi);
  linuxFilesystem(harness.pi);
  linuxUsers(harness.pi);
  linuxProcesses(harness.pi);
  linuxChecks(harness.pi);
  linuxDiagnostics(harness.pi);
  linuxDiscovery(harness.pi);
  return harness;
}

describe("linux operations tools", () => {
  test("registers each Linux tool subset separately", () => {
    const { tools } = registerAll();
    expect(Object.keys(tools)).toEqual(expect.arrayContaining([
      "inspect_os_release", "apt_search", "apt_plan_install", "pacman_query", "pacman_plan_install",
      "systemd_status", "systemd_logs", "systemd_plan_restart",
      "inspect_system_file", "plan_system_file_patch", "apply_system_file_patch",
      "inspect_kernel", "inspect_cpu", "inspect_memory", "inspect_disks", "inspect_mounts", "inspect_gpu", "inspect_network_interfaces",
      "inspect_journal", "inspect_log_file", "search_logs",
      "inspect_ports", "dns_lookup", "http_probe", "ping_probe", "firewall_status",
      "disk_usage_summary", "find_large_files", "plan_delete", "safe_delete",
      "inspect_user", "inspect_groups", "inspect_permissions", "plan_chmod", "apply_permissions_change",
      "list_processes", "inspect_process", "plan_kill_process", "kill_process",
      "run_system_check", "grep_paths", "find_paths", "file_tree_matches",
      "apt_remove", "pacman_plan_remove", "pacman_remove", "systemd_plan_action", "systemd_list_timers", "systemd_reload",
      "inspect_routes", "inspect_resolver", "plan_archive_path", "apply_ownership_change",
      "inspect_boot", "inspect_pressure", "inspect_disk_health", "inspect_open_deleted_files", "inspect_containers", "inspect_kernel_modules", "inspect_time_sync", "inspect_security_updates",
    ]));
  });

  test("shared safety helpers reject broad or critical targets", () => {
    expect(isSafeSystemPath("/etc/ssh/sshd_config")).toBe(true);
    expect(isSafeSystemPath("/home/alex/.config/foo.conf")).toBe(true);
    expect(isSafeSystemPath("/usr/bin/bash")).toBe(false);
    expect(denylistedSystemdUnit("sshd.service")).toContain("critical");
    expect(riskyFilesystemTarget("/" )).toContain("refusing");
    expect(riskyFilesystemTarget("/tmp/keylime-test" )).toBeUndefined();
  });

  test("mutation tools expose dry-run / approval contracts", () => {
    const { tools } = registerAll();
    expect(tools.apply_system_file_patch.promptGuidelines.join("\n")).toContain("backup");
    expect(tools.apt_install.promptGuidelines.join("\n")).toContain("plan");
    expect(tools.safe_delete.promptGuidelines.join("\n")).toContain("plan_delete");
    expect(tools.kill_process.promptGuidelines.join("\n")).toContain("plan_kill_process");
  });

  test("sudo command wrapper carries modal password through stdin", async () => {
    const spec = await sudoPrefix({ ui: { input: async () => "secret" } }, { command: "apt-get", args: ["install", "foo"], sudo: true });
    expect(spec.command).toBe("sudo");
    expect(spec.args).toEqual(["-S", "-p", "", "apt-get", "install", "foo"]);
    expect(spec.stdin).toBe("secret\n");
  });

  test("package tools reject option-like package names before spawning package managers", async () => {
    const { tools } = registerAll();
    await expect(tools.apt_plan_install.execute("id", { packages: ["--danger"] })).rejects.toThrow("Invalid package name");
    await expect(tools.pacman_plan_install.execute("id", { packages: ["-Syu"] })).rejects.toThrow("Invalid package name");
  });

  test("config validation is preset-based rather than arbitrary command execution", () => {
    const { tools } = registerAll();
    const schema = JSON.stringify(tools.validate_config.parameters);
    expect(schema).toContain("validator");
    expect(schema).not.toContain("command");
    expect(schema).not.toContain("args");
  });

  test("guarded mutation schemas require plan tokens", () => {
    const { tools } = registerAll();
    for (const name of ["apt_install", "apt_remove", "pacman_install", "pacman_remove", "systemd_restart", "safe_delete", "archive_path", "apply_permissions_change", "apply_ownership_change", "kill_process", "apply_system_file_patch"]) {
      expect(JSON.stringify(tools[name].parameters)).toContain("plan_token");
    }
  });

  test("operation plans are single-use and bound to kind and target", () => {
    const target = operationTarget({ path: "/tmp/example", mode: "600" });
    const plan = createOperationPlan("chmod", target);
    expect(() => consumeOperationPlan(plan.planToken, "chmod", target)).not.toThrow();
    expect(() => consumeOperationPlan(plan.planToken, "chmod", target)).toThrow("valid plan_token");
    const mismatch = createOperationPlan("chmod", target);
    expect(() => consumeOperationPlan(mismatch.planToken, "chown", target)).toThrow("does not match");
  });

  test("validates option-like operands and constrained mutation values", () => {
    expect(() => validateOperand("--help", "host")).toThrow("Invalid host");
    expect(validateOperand("example.com", "host")).toBe("example.com");
    expect(validateSignal("sigterm")).toBe("TERM");
    expect(() => validateSignal("SEGV")).toThrow("Unsupported");
    expect(validateMode("0640")).toBe("0640");
    expect(() => validateMode("--reference=/tmp/x")).toThrow("Invalid chmod mode");
    expect(validateHttpUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(() => validateHttpUrl("file:///etc/passwd")).toThrow("HTTP(S)");
  });

  test("resolved-root checks reject symlinks escaping an allowed log root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "keylime-linux-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "keylime-linux-outside-"));
    try {
      await mkdir(path.join(root, "logs"));
      await writeFile(path.join(outside, "secret.log"), "secret");
      await symlink(path.join(outside, "secret.log"), path.join(root, "logs", "escape.log"));
      await expect(resolveWithinRoots(path.join(root, "logs", "escape.log"), [path.join(root, "logs")])).rejects.toThrow("outside the allowed roots");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("Linux tools reject execution when Linux capability is inactive", async () => {
    const { tools } = registerAll();
    setCurrentRoute(classifyIntent("write a typescript function"));
    await expect(tools.inspect_kernel.execute("id", {})).rejects.toThrow("linux_ops/linux");
  });
});
