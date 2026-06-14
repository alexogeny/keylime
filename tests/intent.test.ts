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

  test("routes shoe spec questions to shoe tools without forcing biomechanics skill", () => {
    const route = classifyIntent("compare running shoes with 8mm heel drop for pronation");

    expect(route.capabilityGroups).toContain("shoes");
    expect(route.suggestedSkills).toEqual([]);
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


test("explicit research requests route to research even when keyword score is low", () => {
  const route = classifyIntent("research the latest on cold water immersion");

  expect(route.primaryIntent).toBe("research");
  expect(route.temporal.explicitResearchRequested).toBe(true);
  expect(route.capabilityGroups).toContain("research");
  expect(route.capabilityGroups).toContain("fetch");
});


test("routes latest shoe model prompts to shoe lookup not research", () => {
  const route = classifyIntent("tell me about the latest brooks ghost");

  expect(route.primaryIntent).toBe("running_shoes");
  expect(route.capabilityGroups).toContain("shoes");
  expect(route.suggestedSkills).toEqual([]);
});

test("routes gait and injury prompts to biomechanics skill", () => {
  const route = classifyIntent("can you analyze my pronation and knee pain from my gait");

  expect(route.primaryIntent).toBe("running_biomechanics");
  expect(route.suggestedSkills).toContain("running-biomechanics");
});

test("adds research capability for freshness on shoe catalog intents", () => {
  const route = classifyIntent("tell me about the latest brooks ghost");

  expect(route.primaryIntent).toBe("running_shoes");
  expect(route.temporal.freshnessRequested).toBe(true);
  expect(route.temporal.explicitResearchRequested).toBe(false);
  expect(route.capabilityGroups).toContain("shoes");
  expect(route.capabilityGroups).toContain("research");
  expect(route.capabilityGroups).toContain("fetch");
});

test("explicit research requests hijack primary intent but keep shoe tools as secondary", () => {
  const route = classifyIntent("web search the latest brooks ghost and cite sources");

  expect(route.primaryIntent).toBe("research");
  expect(route.temporal.explicitResearchRequested).toBe(true);
  expect(route.capabilityGroups).toContain("research");
  expect(route.capabilityGroups).toContain("shoes");
});

test("ignores system reminders during intent classification", () => {
  const route = classifyIntent("hello there\n\n<system-reminder>web search latest brooks ghost</system-reminder>");

  expect(route.primaryIntent).toBe("chat");
  expect(route.capabilityGroups).toEqual(["readonly", "memory-lite"]);
});

test("routes Python codemod requests to codemod skill", () => {
  const route = classifyIntent("modernize python typing across these files");

  expect(route.primaryIntent).toBe("python_engineering");
  expect(route.suggestedSkills).toContain("python-codemod");
});

test("routes Rust codemod requests to codemod skill", () => {
  const route = classifyIntent("codemod rust and rename rust module imports");

  expect(route.suggestedSkills).toContain("rust-codemod");
});

test("routes generic bulk edit requests to coding tools", () => {
  const route = classifyIntent("replace across files and do a bulk edit");

  expect(route.primaryIntent).toBe("coding");
  expect(route.capabilityGroups).toContain("coding");
});

test("routes Linux sysadmin requests to Linux tools", () => {
  const route = classifyIntent("ubuntu systemd service logs apt install and sudo review");

  expect(route.primaryIntent).toBe("linux_ops");
  expect(route.capabilityGroups).toContain("linux");
  expect(route.capabilityGroups).toContain("safety");
});
