import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import linuxPackages from "../extensions/linux-packages";
import linuxSystemd from "../extensions/linux-systemd";
import linuxFiles from "../extensions/linux-files";
import linuxHardware from "../extensions/linux-hardware";
import linuxLogs, { parseBootSessions } from "../extensions/linux-logs";
import linuxNetwork from "../extensions/linux-network";
import linuxFilesystem from "../extensions/linux-filesystem";
import linuxUsers from "../extensions/linux-users";
import linuxProcesses from "../extensions/linux-processes";
import linuxChecks from "../extensions/linux-checks";
import linuxDiagnostics, { classifyEvidence, collectDashboardSnapshot, extractServiceUnits, parseNetworkDeviceCounters, parsePressure, probeCommand, probeFile } from "../extensions/linux-diagnostics";
import linuxDiscovery from "../extensions/linux-discovery";
import { consumeOperationPlan, createOperationPlan, isSafeSystemPath, denylistedSystemdUnit, operationTarget, resolveWithinRoots, riskyFilesystemTarget, runCommand, sudoPrefix, validateHttpUrl, validateMode, validateOperand, validateSignal } from "../extensions/shared/linux-safety";
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
      "inspect_thermal_power", "inspect_hardware_crash_evidence",
      "inspect_journal", "list_boot_sessions", "diagnose_shutdowns", "inspect_log_file", "search_logs",
      "inspect_ports", "dns_lookup", "http_probe", "ping_probe", "firewall_status",
      "disk_usage_summary", "find_large_files", "plan_delete", "safe_delete",
      "inspect_user", "inspect_groups", "inspect_permissions", "plan_chmod", "apply_permissions_change",
      "list_processes", "inspect_process", "plan_kill_process", "kill_process",
      "run_system_check", "grep_paths", "find_paths", "file_tree_matches",
      "apt_remove", "pacman_plan_remove", "pacman_remove", "systemd_plan_action", "systemd_list_timers", "systemd_reload",
      "inspect_routes", "inspect_resolver", "plan_archive_path", "apply_ownership_change",
      "inspect_boot", "inspect_pressure", "inspect_disk_health", "inspect_open_deleted_files", "inspect_containers", "inspect_kernel_modules", "inspect_time_sync", "inspect_security_updates",
      "diagnose_system_health", "inspect_kernel_anomalies", "inspect_resource_pressure", "inspect_service_failures",
      "inspect_storage_health", "inspect_network_health", "inspect_boot_performance", "correlate_system_incident",
    ]));
  });

  test("journal tools expose bounded boot and filter schemas", () => {
    const { tools } = registerAll();
    const journal = tools.inspect_journal.parameters.properties;
    expect(Object.keys(journal)).toEqual(expect.arrayContaining(["boot", "until", "grep", "reverse", "lines", "since", "priority", "unit"]));
    expect(journal.lines.minimum).toBe(1);
    expect(journal.lines.maximum).toBe(1000);
    expect(journal.boot.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "integer", minimum: -1000, maximum: 0 }),
      expect.objectContaining({ type: "string", pattern: "^[0-9a-fA-F]{32}$" }),
    ]));
    expect(tools.list_boot_sessions.parameters.properties.count.maximum).toBe(100);
    expect(tools.diagnose_shutdowns.parameters.properties.boots.maximum).toBe(10);
    expect(tools.diagnose_shutdowns.parameters.properties.lines.maximum).toBe(1000);
  });

  test("new Linux inspection tools do not accept arbitrary commands or args", () => {
    const { tools } = registerAll();
    for (const name of ["inspect_journal", "list_boot_sessions", "diagnose_shutdowns", "inspect_thermal_power", "inspect_hardware_crash_evidence"]) {
      const properties = tools[name].parameters.properties;
      expect(properties.command).toBeUndefined();
      expect(properties.args).toBeUndefined();
    }
  });

  test("thermal sampling and crash evidence counts are bounded", () => {
    const { tools } = registerAll();
    const thermal = tools.inspect_thermal_power.parameters.properties;
    expect(thermal.duration_seconds.minimum).toBe(0);
    expect(thermal.duration_seconds.maximum).toBe(30);
    expect(thermal.sample_count.minimum).toBe(1);
    expect(thermal.sample_count.maximum).toBe(30);
    const crash = tools.inspect_hardware_crash_evidence.parameters.properties;
    expect(crash.max_files.maximum).toBe(20);
    expect(crash.max_chars.maximum).toBe(20000);
  });

  test("advanced diagnostics are bounded and expose no arbitrary execution", () => {
    const { tools } = registerAll();
    const names = ["diagnose_system_health", "inspect_kernel_anomalies", "inspect_resource_pressure", "inspect_service_failures", "inspect_storage_health", "inspect_network_health", "inspect_boot_performance", "correlate_system_incident"];
    for (const name of names) {
      const properties = tools[name].parameters.properties;
      expect(properties.command).toBeUndefined();
      expect(properties.args).toBeUndefined();
    }
    expect(tools.diagnose_system_health.parameters.properties.process_limit.maximum).toBe(50);
    expect(tools.inspect_kernel_anomalies.parameters.properties.lines.maximum).toBe(2000);
    expect(tools.inspect_resource_pressure.parameters.properties.duration_seconds.maximum).toBe(30);
    expect(tools.inspect_resource_pressure.parameters.properties.sample_count.maximum).toBe(30);
    expect(tools.inspect_service_failures.parameters.properties.max_units.maximum).toBe(20);
    expect(tools.inspect_storage_health.parameters.properties.max_devices.maximum).toBe(12);
    expect(tools.inspect_network_health.parameters.properties.ping_count.maximum).toBe(5);
    expect(tools.inspect_boot_performance.parameters.properties.max_units.maximum).toBe(100);
    expect(tools.correlate_system_incident.parameters.properties.max_events.maximum).toBe(500);
  });

  test("diagnostic parsers classify representative Linux evidence", () => {
    expect(parseBootSessions(" -1 0123456789abcdef0123456789abcdef Mon 2026-01-01 10:00:00 UTC — Mon 2026-01-01 11:00:00 UTC")).toEqual([
      expect.objectContaining({ offset: -1, id: "0123456789abcdef0123456789abcdef" }),
    ]);
    const pressure = parsePressure("some avg10=1.25 avg60=0.50 avg300=0.10 total=42\nfull avg10=0.25 avg60=0.10 avg300=0.01 total=9");
    expect(pressure.some.avg10).toBe(1.25);
    expect(pressure.full.total).toBe(9);
    const evidence = classifyEvidence("kernel: Out of memory: Killed process 42\nkernel: nvme0: I/O error\nsystemd[1]: demo.service: Main process exited", 20);
    expect(evidence.categories.out_of_memory.count).toBeGreaterThan(0);
    expect(evidence.categories.storage_io.count).toBeGreaterThan(0);
    expect(evidence.categories.service.count).toBeGreaterThan(0);
    expect(extractServiceUnits("demo.service loaded failed failed Demo", "systemd[1]: loop.service: Scheduled restart job", 10)).toEqual(["demo.service", "loop.service"]);
    const interfaces = parseNetworkDeviceCounters("eth0: 100 2 2 3 0 0 0 0 200 4 4 5 0 6 0 0");
    expect(interfaces[0]).toEqual(expect.objectContaining({ interface: "eth0", receive_errors: 2, transmit_drops: 5, has_errors: true }));
  });

  test("diagnostic probes degrade gracefully when interfaces are absent or commands fail", async () => {
    const missingFile = await probeFile("missing", "/definitely/not/a/keylime/interface");
    const missingCommand = await probeCommand("missing", "keylime-command-that-does-not-exist", []);
    const failedCommand = await probeCommand("failed", process.execPath, ["-e", "process.stderr.write('denied'); process.exit(3)"]);
    expect(missingFile.status).toBe("unavailable");
    expect(missingCommand.status).toBe("unavailable");
    expect(failedCommand).toEqual(expect.objectContaining({ status: "error", output: expect.stringContaining("denied") }));
  });

  test("runCommand supports larger explicit bounded output previews", async () => {
    const script = "process.stdout.write('x'.repeat(20000))";
    const normal = await runCommand({ command: process.execPath, args: ["-e", script] });
    const expanded = await runCommand({ command: process.execPath, args: ["-e", script] }, { maxOutputChars: 12000 });
    expect(normal.stdout.length).toBeLessThan(6100);
    expect(expanded.stdout.length).toBeGreaterThan(11000);
    expect(expanded.stdout.length).toBeLessThan(12100);
  });

  test("registers the interactive system dashboard command", () => {
    const { commands } = registerAll();
    expect(commands["system-dashboard"]?.description).toContain("dashboard");
  });

  if (process.platform === "linux" && process.env.KEYLIME_LINUX_SMOKE === "1") {
    test("advanced diagnostics smoke-test on the current Linux host", async () => {
      const { tools } = registerAll();
      const results = await Promise.all([
        tools.inspect_resource_pressure.execute("smoke", { duration_seconds: 0, sample_count: 1, process_limit: 3 }),
        tools.inspect_network_health.execute("smoke", { journal_lines: 20 }),
        tools.inspect_storage_health.execute("smoke", { max_devices: 1, include_device_health: false, journal_lines: 20 }),
        tools.inspect_boot_performance.execute("smoke", { max_units: 5, warning_lines: 20 }),
      ]);
      for (const result of results) {
        expect(result.isError).not.toBe(true);
        expect(() => JSON.parse(result.content[0].text)).not.toThrow();
      }
      const dashboard = await collectDashboardSnapshot();
      expect(dashboard.cpu.total).toBeGreaterThan(0);
      expect(dashboard.processes.length).toBeGreaterThan(0);
    }, 60_000);
  }

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
