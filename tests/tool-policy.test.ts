import { describe, expect, test } from "bun:test";
import { ALWAYS_ON_CODE_TOOLS, CAPABILITY_TOOLS, DOMAIN_TOOLS } from "../extensions/intent-router";
import { alwaysOnToolNames, capabilityToolMap, domainToolNames, knownToolNames, toolPolicyFor } from "../extensions/shared/tool-policy";

describe("shared tool policy", () => {
  test("router derives always-on, capability, and domain tools from shared policy", () => {
    expect(ALWAYS_ON_CODE_TOOLS).toEqual(alwaysOnToolNames());
    expect(CAPABILITY_TOOLS).toEqual(capabilityToolMap());
    expect(DOMAIN_TOOLS).toEqual(new Set(domainToolNames()));
  });

  test("safe policy/codemod/check helpers are known always-on safe tools", () => {
    for (const name of ["retrieve_policy", "suggest_checks", "codemod_plan", "inspect_tool_result"]) {
      expect(knownToolNames()).toContain(name);
      expect(toolPolicyFor(name)).toMatchObject({ alwaysOn: true, risk: "safe" });
    }
  });

  test("dangerous built-ins are known but not always-on safe tools", () => {
    expect(toolPolicyFor("bash")).toMatchObject({ alwaysOn: false, risk: "guarded" });
    expect(toolPolicyFor("read")).toMatchObject({ alwaysOn: false, risk: "guarded" });
    expect(toolPolicyFor("write")).toMatchObject({ alwaysOn: false, risk: "dangerous" });
    expect(alwaysOnToolNames()).not.toContain("bash");
  });
});
