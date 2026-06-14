import { describe, expect, test } from "bun:test";
import { customCheckCommand, defaultCheckCommands, detectProjectKind } from "../extensions/shared/test-runner";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";
import { runChecksCommandBlockReason, summarizeCheckStream } from "../extensions/test-runner";

describe("test runner defaults", () => {
  test("detects project kind", () => {
    expect(detectProjectKind(["Cargo.toml"])).toBe("rust");
    expect(detectProjectKind(["pyproject.toml"])).toBe("python");
    expect(detectProjectKind(["package.json"])).toBe("typescript");
    expect(detectProjectKind(["extensions/package.json"])).toBe("typescript");
    expect(detectProjectKind([])).toBe("unknown");
  });

  test("builds TypeScript default commands", () => {
    const commands = defaultCheckCommands("typescript", "all");

    expect(commands.map(c => c.command)).toEqual(["bun", "bash"]);
    expect(commands[0].args).toEqual(["test"]);
  });

  test("builds Rust and Python defaults", () => {
    expect(defaultCheckCommands("rust", "typecheck")[0].label).toBe("cargo check");
    expect(defaultCheckCommands("python", "test")[0].label).toBe("pytest");
  });

  test("run_checks prompt guidelines prefer the tool over bash", async () => {
    const { default: testRunnerExtension } = await import("../extensions/test-runner");
    const tools: Record<string, any> = {};
    testRunnerExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);

    expect(tools.run_checks.promptGuidelines.join("\n")).toContain("Prefer run_checks over bash");
  });

  test("blocks custom command bypasses in coding mode policy", () => {
    expect(runChecksCommandBlockReason("python", ["-c", "open('x', 'w').write('y')"])).toContain("inline execution");
    expect(runChecksCommandBlockReason("node", ["-e", "require('fs').writeFileSync('x', 'y')"])).toContain("inline execution");
    expect(runChecksCommandBlockReason("bash", ["-c", "echo hi > file"])).toContain("bypass");
    expect(runChecksCommandBlockReason("git", ["add", "."])).toContain("git");
    expect(runChecksCommandBlockReason("git", ["commit", "-m", "x"])).toContain("git");
    expect(runChecksCommandBlockReason("rm", ["file.ts"])).toContain("file mutation");
    expect(runChecksCommandBlockReason("mkdir", ["src/generated"])).toContain("file mutation");
    expect(runChecksCommandBlockReason("grep", ["foo", "src", ">", "results.txt"])).toContain("redirection");
    expect(runChecksCommandBlockReason("prettier", ["--write", "."])).toContain("verification-only");
    expect(runChecksCommandBlockReason("eslint", ["--fix", "."])).toContain("verification-only");
    expect(runChecksCommandBlockReason("cargo", ["fmt"])).toContain("verification-only");
    expect(runChecksCommandBlockReason("npm", ["install"])).toContain("verification-only");
    expect(runChecksCommandBlockReason("bun test tests", [])).toContain("shell-style");
    expect(runChecksCommandBlockReason("bun", ["test", "tests"])).toBeNull();
    expect(runChecksCommandBlockReason("cargo", ["test"])).toBeNull();
  });

  test("run_checks rejects blocked custom commands even outside coding mode", async () => {
    setCurrentRoute(classifyIntent("hello"));
    const tools: Record<string, any> = {};
    const { default: testRunnerExtension } = await import("../extensions/test-runner");
    testRunnerExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);

    await expect(tools.run_checks.execute("id", {
      command: "sudo",
      args: ["rm", "file.ts"],
    }, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow("run_checks blocked custom command");
  });

  test("run_checks rejects blocked custom commands when coding is active", async () => {
    const { default: testRunnerExtension } = await import("../extensions/test-runner");
    const tools: Record<string, any> = {};
    testRunnerExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
    setCurrentRoute(classifyIntent("implement code change"));

    await expect(tools.run_checks.execute("id", {
      command: "python",
      args: ["-c", "open('x', 'w').write('y')"],
    }, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow("run_checks blocked custom command");

    setCurrentRoute(classifyIntent("hello"));
  });

  test("run_checks reports exact command argv", async () => {
    const { default: testRunnerExtension } = await import("../extensions/test-runner");
    const tools: Record<string, any> = {};
    testRunnerExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);

    const result = await tools.run_checks.execute("id", { command: "bun", args: ["--version"] }, undefined, undefined, { cwd: process.cwd() });

    expect(result.content[0].text).toContain("Ran: bun --version");
  });

  test("summarizes large check streams while preserving key failure lines", () => {
    const large = [
      "start of output",
      "Error: expected true received false",
      ...Array.from({ length: 400 }, (_, i) => `boring line ${i}`),
      "tail of output",
    ].join("\n");

    const summarized = summarizeCheckStream(large, 500);

    expect(summarized).toContain("Output summarized");
    expect(summarized).toContain("Error: expected true received false");
    expect(summarized.length).toBeLessThan(900);
  });

  test("custom command accepts either argv or a shell-style command string", () => {
    expect(customCheckCommand("bun", ["test", "tests"])).toEqual({
      command: "bun",
      args: ["test", "tests"],
      label: "bun test tests",
    });

    expect(customCheckCommand("bun test tests")).toEqual({
      command: "bash",
      args: ["-lc", "bun test tests"],
      label: "bun test tests",
    });
  });
});
