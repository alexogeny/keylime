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
