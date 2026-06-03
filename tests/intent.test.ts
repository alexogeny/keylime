import { describe, expect, test } from "bun:test";
import { classifyIntent } from "../extensions/shared/intent";

describe("classifyIntent", () => {
  test("routes Python performance work to coding plus python skill", () => {
    const route = classifyIntent("can you optimize this python hot path");

    expect(route.primaryIntent).toBe("python_engineering");
    expect(route.capabilityGroups).toContain("coding");
    expect(route.capabilityGroups).toContain("repo");
    expect(route.suggestedSkills).toContain("python-eng");
  });

  test("routes shoe questions to shoe capability", () => {
    const route = classifyIntent("compare running shoes with 8mm heel drop for pronation");

    expect(route.primaryIntent).toBe("running_shoes");
    expect(route.capabilityGroups).toContain("shoes");
    expect(route.suggestedSkills).toContain("running-biomechanics");
  });

  test("routes ordinary implementation requests to coding", () => {
    const route = classifyIntent("this is a good plan can you build it please");

    expect(route.primaryIntent).toBe("coding");
    expect(route.capabilityGroups).toContain("coding");
    expect(route.capabilityGroups).toContain("repo");
  });

  test("keeps unrelated chat lightweight", () => {
    const route = classifyIntent("what do you think about this idea");

    expect(route.primaryIntent).toBe("chat");
    expect(route.capabilityGroups).toEqual(["readonly", "memory-lite"]);
  });
});

test("routes prompt/cache extension review to review", () => {
  const route = classifyIntent("review these extensions for prompt pollution and cache invalidation");

  expect(route.primaryIntent).toBe("review");
  expect(route.capabilityGroups).toContain("repo");
});

test("routes Rust shell emulator work to shell skill", () => {
  const route = classifyIntent("fix the pty job control in this rust shell emulator");

  expect(route.primaryIntent).toBe("rust_shell_emulator");
  expect(route.suggestedSkills).toContain("rust-shell-emulator");
});

test("routes docs and URL prompts to research/fetch", () => {
  const route = classifyIntent("read this url and compare it with the official docs");

  expect(route.primaryIntent).toBe("research");
  expect(route.capabilityGroups).toContain("fetch");
});
