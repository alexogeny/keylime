import { describe, expect, test } from "bun:test";
import { ALWAYS_ON_CODE_TOOLS, CAPABILITY_TOOLS, DOMAIN_TOOLS } from "../extensions/intent-router";
import { alwaysOnToolNames, capabilityToolMap, domainToolNames, knownToolNames, toolPolicyFor } from "../extensions/shared/tool-policy";

describe("shared tool policy", () => {
  test("router derives always-on, capability, and domain tools from shared policy", () => {
    expect(ALWAYS_ON_CODE_TOOLS).toEqual(alwaysOnToolNames());
    expect(CAPABILITY_TOOLS).toEqual(capabilityToolMap());
    expect(DOMAIN_TOOLS).toEqual(new Set(domainToolNames()));
  });

  test("policy/codemod/check helpers are known but routed instead of always-on", () => {
    for (const name of ["retrieve_policy", "suggest_checks", "codemod_plan", "inspect_tool_result"]) {
      expect(knownToolNames()).toContain(name);
      expect(toolPolicyFor(name)).toMatchObject({ alwaysOn: false, risk: "safe" });
      expect(capabilityToolMap().safety).toContain(name);
    }
    expect(toolPolicyFor("run_checks")).toMatchObject({ group: "coding", alwaysOn: false, risk: "safe" });
  });

  test("dangerous built-ins are known but not always-on safe tools", () => {
    expect(toolPolicyFor("bash")).toMatchObject({ alwaysOn: false, risk: "guarded" });
    expect(toolPolicyFor("read")).toMatchObject({ alwaysOn: false, risk: "guarded" });
    expect(toolPolicyFor("write")).toMatchObject({ alwaysOn: false, risk: "dangerous" });
    expect(alwaysOnToolNames()).not.toContain("bash");
  });

  test("mutation, repo, and tool-result maintenance tools are routed, not always-on", () => {
    expect(alwaysOnToolNames()).not.toContain("commit_history");
    expect(alwaysOnToolNames()).not.toContain("git_status");
    expect(alwaysOnToolNames()).not.toContain("apply_code_replacements");
    expect(alwaysOnToolNames()).not.toContain("list_tool_results");
    expect(capabilityToolMap().repo).toContain("commit_history");
    expect(capabilityToolMap().repo).toContain("git_status");
    expect(capabilityToolMap().coding).toContain("apply_code_replacements");
    expect(capabilityToolMap().coding).toContain("list_tool_results");
  });

  test("stateful memory timeline tool is domain-routed, not preserved as an unknown tool", () => {
    expect(toolPolicyFor("remember_timeline")).toMatchObject({ group: "memory", domain: true, risk: "stateful" });
    expect(domainToolNames()).toContain("remember_timeline");
  });
});
