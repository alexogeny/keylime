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
import contextObjectStore from "../extensions/context-object-store";
import structuredCompaction from "../extensions/structured-compaction";
import boundedToolPipeline from "../extensions/bounded-tool-pipeline";
import webContent from "../extensions/web-content";
import contextRuntime from "../extensions/context-runtime";
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
    contextObjectStore(harness.pi);
    structuredCompaction(harness.pi);
    boundedToolPipeline(harness.pi);
    webContent(harness.pi);
    contextRuntime(harness.pi);

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
      "inspect_context_object",
      "bounded_tool_pipeline",
      "context_runtime_status",
      "run_checks",
      "read_agent_registers",
      "ctx_region_write",
      "compile_tool_grammar",
      "crawl_site",
      "sync_site_crawl",
      "get_site_page",
      "search_site_content",
      "list_site_crawls",
    ]));
    expect(Object.keys(harness.commands)).toEqual(expect.arrayContaining([
      "agent-status",
      "tool-policy",
      "intent-status",
      "danger-rules",
      "checkpoint",
      "keylime",
      "keylime-stop",
      "context-runtime",
    ]));
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining([
      "tool_result",
      "tool_call",
      "input",
      "context",
      "agent_end",
      "model_select",
      "session_before_compact",
      "turn_end",
      "message_end",
    ]));
  });
});
