import { describe, expect, test } from "bun:test";
import { ALWAYS_ON_CODE_TOOLS, CAPABILITY_TOOLS, DOMAIN_TOOLS } from "../extensions/intent-router";
import { alwaysOnToolNames, capabilityToolMap, domainToolNames, knownToolNames, resolveActiveToolSet, toolPolicyFor } from "../extensions/shared/tool-policy";

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
    expect(toolPolicyFor("run_checks")).toMatchObject({ group: "coding", alwaysOn: true, risk: "safe" });
    expect(toolPolicyFor("compile_tool_grammar")).toMatchObject({ group: "coding", alwaysOn: false, risk: "stateful" });
    expect(capabilityToolMap().coding).toContain("current_agent_budget");
  });

  test("dangerous built-ins are known but not always-on or routed by default", () => {
    expect(toolPolicyFor("bash")).toMatchObject({ alwaysOn: false, risk: "guarded" });
    expect(toolPolicyFor("read")).toMatchObject({ alwaysOn: false, risk: "guarded" });
    expect(toolPolicyFor("write")).toMatchObject({ alwaysOn: false, risk: "dangerous" });
    expect(alwaysOnToolNames()).not.toContain("bash");
    expect(capabilityToolMap().core).not.toContain("bash");
    expect(capabilityToolMap().coding).not.toContain("bash");
  });

  test("safe file mutation tools are always-on while repo and maintenance tools stay routed", () => {
    expect(alwaysOnToolNames()).toContain("apply_code_replacements");
    expect(alwaysOnToolNames()).toContain("create_file");
    expect(alwaysOnToolNames()).toContain("begin_file_write");
    expect(alwaysOnToolNames()).toContain("run_checks");
    expect(alwaysOnToolNames()).not.toContain("commit_history");
    expect(alwaysOnToolNames()).not.toContain("git_status");
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

  test("shared resolver preserves safe primitives and non-domain tools without preserving routed domain drift", () => {
    const resolution = resolveActiveToolSet({
      availableToolNames: ["code_search", "apply_code_replacements", "custom_safe_tool", "lookup_shoe", "bash", "fetch_url"],
      currentActiveToolNames: ["custom_safe_tool", "lookup_shoe"],
      groups: ["readonly"],
      continuityToolNames: ["apply_code_replacements"],
    });

    expect(resolution.active).toContain("code_search");
    expect(resolution.active).toContain("apply_code_replacements");
    expect(resolution.active).toContain("fetch_url");
    expect(resolution.active).toContain("custom_safe_tool");
    expect(resolution.active).not.toContain("lookup_shoe");
    expect(resolution.active).not.toContain("bash");
  });
});
