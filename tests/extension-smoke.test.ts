import { describe, expect, test } from "bun:test";
import codePrimitives from "../extensions/code-primitives";
import dangerGuard from "../extensions/danger-guard";
import gitCheckpoint from "../extensions/git-checkpoint";
import intentRouter from "../extensions/intent-router";
import policyTools from "../extensions/policy-tools";
import testRunner from "../extensions/test-runner";
import toolResultCompactor from "../extensions/tool-result-compactor";
import { mockPiFixture } from "./helpers/mock-pi";

describe("extension registration smoke", () => {
  test("core coding/policy/safety extensions register expected tools, commands, and handlers", () => {
    const harness = mockPiFixture();

    codePrimitives(harness.pi);
    policyTools(harness.pi);
    toolResultCompactor(harness.pi);
    testRunner(harness.pi);
    intentRouter(harness.pi);
    dangerGuard(harness.pi);
    gitCheckpoint(harness.pi);

    expect(Object.keys(harness.tools)).toEqual(expect.arrayContaining([
      "list_files",
      "inspect_json",
      "apply_code_replacements",
      "retrieve_policy",
      "suggest_checks",
      "codemod_plan",
      "inspect_tool_result",
      "run_checks",
    ]));
    expect(Object.keys(harness.commands)).toEqual(expect.arrayContaining([
      "agent-status",
      "tool-policy",
      "intent-status",
      "danger-rules",
      "checkpoint",
    ]));
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining([
      "tool_result",
      "tool_call",
      "input",
      "context",
      "agent_end",
    ]));
  });
});
