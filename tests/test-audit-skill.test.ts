import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("test-audit skill", () => {
  test("bakes in unit-test quality guidance beyond coverage percentage", async () => {
    const skill = await readFile("skills/test-audit/SKILL.md", "utf8");

    expect(skill).toContain("fault-detection power");
    expect(skill).toContain("Mutation-testing thinking");
    expect(skill).toContain("Branch / condition coverage");
    expect(skill).toContain("Property / metamorphic coverage");
    expect(skill).toContain("risk map");
    expect(skill).toContain("integration seams");
  });

  test("TDD guide invokes test-audit before and after implementation", async () => {
    const planner = await readFile("extensions/project-planner.ts", "utf8");

    expect(planner).toContain("invoke /skill:test-audit to turn acceptance criteria into a behavior/risk matrix");
    expect(planner).toContain("invoke /skill:test-audit again to spot missing edge cases beyond coverage %");
  });
});
