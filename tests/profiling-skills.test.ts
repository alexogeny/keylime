import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("profiling-aware optimization skills", () => {
  test("python engineering skill points optimization work at profiling tools", async () => {
    const skill = await readFile("skills/python-engineering/SKILL.md", "utf8");

    expect(skill).toContain("plan_python_profile");
    expect(skill).toContain("run_python_profile");
    expect(skill).toContain("inspect_profiler_availability");
    expect(skill).toContain("For pasted code blocks without a repo workload");
  });

  test("rust systems skill points optimization work at profiling tools", async () => {
    const skill = await readFile("skills/rust-systems/SKILL.md", "utf8");

    expect(skill).toContain("plan_rust_profile");
    expect(skill).toContain("run_rust_profile");
    expect(skill).toContain("inspect_profiler_availability");
    expect(skill).toContain("For pasted code blocks without a runnable crate/workload");
  });
});
