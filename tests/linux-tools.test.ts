import { describe, expect, test } from "bun:test";
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
import { isSafeSystemPath, denylistedSystemdUnit, riskyFilesystemTarget, sudoPrefix } from "../extensions/shared/linux-safety";
import { mockPiFixture } from "./helpers/mock-pi";

function registerAll() {
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
      "run_system_check",
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
});
