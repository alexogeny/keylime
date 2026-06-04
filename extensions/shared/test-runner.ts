export type CheckSuite = "all" | "test" | "typecheck" | "lint";
export type ProjectKind = "typescript" | "python" | "rust" | "unknown";

export type CheckCommand = {
  command: string;
  args: string[];
  label: string;
};

export function detectProjectKind(files: string[]): ProjectKind {
  const set = new Set(files);
  if (set.has("Cargo.toml")) return "rust";
  if (set.has("pyproject.toml") || set.has("pytest.ini") || set.has("requirements.txt")) return "python";
  if (set.has("package.json") || set.has("bun.lock") || set.has("tsconfig.json")) return "typescript";
  if (set.has("extensions/package.json") || set.has("extensions/bun.lock") || set.has("extensions/tsconfig.json")) return "typescript";
  return "unknown";
}

export function defaultCheckCommands(kind: ProjectKind, suite: CheckSuite): CheckCommand[] {
  if (kind === "rust") {
    if (suite === "test") return [{ command: "cargo", args: ["test"], label: "cargo test" }];
    if (suite === "typecheck") return [{ command: "cargo", args: ["check"], label: "cargo check" }];
    if (suite === "lint") return [{ command: "cargo", args: ["clippy", "--", "-D", "warnings"], label: "cargo clippy" }];
    return [
      { command: "cargo", args: ["check"], label: "cargo check" },
      { command: "cargo", args: ["test"], label: "cargo test" },
    ];
  }

  if (kind === "python") {
    if (suite === "test" || suite === "all") return [{ command: "pytest", args: [], label: "pytest" }];
    if (suite === "typecheck") return [{ command: "mypy", args: ["."], label: "mypy ." }];
    if (suite === "lint") return [{ command: "ruff", args: ["check", "."], label: "ruff check ." }];
  }

  if (kind === "typescript") {
    if (suite === "test") return [{ command: "bun", args: ["test"], label: "bun test" }];
    if (suite === "typecheck") return [{ command: "bash", args: ["-lc", "bun --check extensions/shared/*.ts extensions/*.ts tests/*.test.ts"], label: "bun --check" }];
    if (suite === "lint") return [];
    return [
      { command: "bun", args: ["test"], label: "bun test" },
      { command: "bash", args: ["-lc", "bun --check extensions/shared/*.ts extensions/*.ts tests/*.test.ts"], label: "bun --check" },
    ];
  }

  return [];
}
