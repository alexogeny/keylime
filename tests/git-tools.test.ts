import { describe, expect, test } from "bun:test";
import gitToolsExtension, { resolveGitSafePath, validateGitRef } from "../extensions/git-tools";

function registeredGitTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  gitToolsExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  return tools;
}

describe("safe git inspection tools", () => {
  test("registers read-only git inspection tools", () => {
    const tools = registeredGitTools();

    expect(Object.keys(tools).sort()).toEqual(["commit_history", "inspect_at_checkpoint", "see_file_commit_history"]);
    expect(tools.commit_history.promptGuidelines.join("\n")).toContain("Never use raw git commit/add/reset");
  });

  test("validates git refs and paths", () => {
    expect(validateGitRef("HEAD")).toBe("HEAD");
    expect(validateGitRef("feature/test-1")).toBe("feature/test-1");
    expect(() => validateGitRef("HEAD~1;rm -rf .")).toThrow("Unsafe git ref");
    expect(() => validateGitRef("HEAD..main")).toThrow("Unsafe git ref");

    expect(resolveGitSafePath("/repo", "src/a.ts")).toBe("src/a.ts");
    expect(() => resolveGitSafePath("/repo", "../secret.txt")).toThrow("outside cwd");
  });

  test("commit_history executes bounded read-only git log", async () => {
    const tools = registeredGitTools();
    const result = await tools.commit_history.execute("id", { max_count: 3 }, undefined, undefined, { cwd: process.cwd() });

    expect(result.content[0].text.length).toBeGreaterThan(0);
    expect(result.details.max_count).toBe(3);
  });
});
