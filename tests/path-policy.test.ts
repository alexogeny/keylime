import { describe, expect, test } from "bun:test";
import { isPathWithin, resolveSafePath } from "../extensions/shared/path-policy";

describe("shared path containment", () => {
  test("accepts descendants without accepting sibling prefixes", () => {
    expect(isPathWithin("/workspace/app", "/workspace/app/src/file.ts")).toBe(true);
    expect(isPathWithin("/workspace/app", "/workspace/application/file.ts")).toBe(false);
    expect(isPathWithin("/workspace/app", "/workspace/app-archive/file.ts")).toBe(false);
  });

  test("controls whether the root itself is accepted", () => {
    expect(isPathWithin("/workspace/app", "/workspace/app")).toBe(false);
    expect(isPathWithin("/workspace/app", "/workspace/app", { allowRoot: true })).toBe(true);
  });

  test("resolves safe relative paths and rejects escapes", () => {
    expect(resolveSafePath("/workspace/app", "src/file.ts")).toBe("/workspace/app/src/file.ts");
    expect(() => resolveSafePath("/workspace/app", "../application/file.ts")).toThrow("outside cwd");
  });
});
