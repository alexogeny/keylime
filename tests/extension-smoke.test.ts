import { describe, expect, test } from "bun:test";
import agentOs from "../extensions/agent-os";
import codePrimitives from "../extensions/code-primitives";
import dangerGuard from "../extensions/danger-guard";
import documentPrimitives from "../extensions/document-primitives";
import gitCheckpoint from "../extensions/git-checkpoint";
import intentRouter from "../extensions/intent-router";
import policyTools from "../extensions/policy-tools";
import testRunner from "../extensions/test-runner";
import toolResultCompactor from "../extensions/tool-result-compactor";
import controlPlaneApi from "../extensions/control-plane-api";
import { mockPiFixture } from "./helpers/mock-pi";

describe("extension registration smoke", () => {
  test("core coding/policy/safety extensions register expected tools, commands, and handlers", () => {
    const harness = mockPiFixture();

    agentOs(harness.pi);
    codePrimitives(harness.pi);
    documentPrimitives(harness.pi);
    policyTools(harness.pi);
    toolResultCompactor(harness.pi);
    testRunner(harness.pi);
    intentRouter(harness.pi);
    dangerGuard(harness.pi);
    gitCheckpoint(harness.pi);
    controlPlaneApi(harness.pi);

    expect(Object.keys(harness.tools)).toEqual(expect.arrayContaining([
      "list_files",
      "inspect_json",
      "apply_code_replacements",
      "inspect_document",
      "create_reporter_document",
      "retrieve_policy",
      "suggest_checks",
      "codemod_plan",
      "inspect_tool_result",
      "run_checks",
      "read_agent_registers",
      "ctx_region_write",
      "compile_tool_grammar",
    ]));
    expect(Object.keys(harness.commands)).toEqual(expect.arrayContaining([
      "agent-status",
      "tool-policy",
      "intent-status",
      "danger-rules",
      "checkpoint",
      "keylime",
      "keylime-stop",
    ]));
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining([
      "tool_result",
      "tool_call",
      "input",
      "context",
      "agent_end",
      "model_select",
    ]));
  });
});
