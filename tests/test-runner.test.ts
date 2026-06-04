import { describe, expect, test } from "bun:test";
import { customCheckCommand, defaultCheckCommands, detectProjectKind } from "../extensions/shared/test-runner";

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
