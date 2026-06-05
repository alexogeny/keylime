import { describe, expect, test } from "bun:test";
import codePrimitives from "../extensions/code-primitives";
import dangerGuard from "../extensions/danger-guard";
import gitCheckpoint from "../extensions/git-checkpoint";
import intentRouter from "../extensions/intent-router";
import policyTools from "../extensions/policy-tools";
import testRunner from "../extensions/test-runner";
import toolResultCompactor from "../extensions/tool-result-compactor";

function mockPi() {
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const handlers: Record<string, any[]> = {};
  const pi = {
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
    getAllTools: () => Object.keys(tools).map(name => ({ name })),
    getActiveTools: () => Object.keys(tools).map(name => ({ name })),
    setActiveTools: () => {},
    appendEntry: () => {},
    registerShortcut: () => {},
  } as any;
  return { pi, tools, commands, handlers };
}

describe("extension registration smoke", () => {
  test("core coding/policy/safety extensions register expected tools, commands, and handlers", () => {
    const harness = mockPi();

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
