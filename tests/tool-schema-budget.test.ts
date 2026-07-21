import { describe, expect, test } from "bun:test";
import agentOs from "../extensions/agent-os";
import codePrimitives from "../extensions/code-primitives";
import documentPrimitives from "../extensions/document-primitives";
import policyTools from "../extensions/policy-tools";
import repoIndex from "../extensions/repo-index/index";
import testRunner from "../extensions/test-runner";
import toolResultCompactor from "../extensions/tool-result-compactor";
import { estimateRegisteredToolChars } from "../extensions/shared/tool-catalog";
import { bootstrapToolNames } from "../extensions/shared/tool-policy";
import { mockPiFixture } from "./helpers/mock-pi";

describe("tool schema budget", () => {
  test("core bootstrap definitions stay bounded relative to the registered catalog", () => {
    const harness = mockPiFixture();
    agentOs(harness.pi);
    codePrimitives(harness.pi);
    documentPrimitives(harness.pi);
    policyTools(harness.pi);
    repoIndex(harness.pi);
    testRunner(harness.pi);
    toolResultCompactor(harness.pi);

    const all = Object.values(harness.tools);
    const bootstrap = bootstrapToolNames().map(name => harness.tools[name]).filter(Boolean);
    const allChars = estimateRegisteredToolChars(all);
    const bootstrapChars = estimateRegisteredToolChars(bootstrap);

    expect(bootstrapToolNames()).toHaveLength(9);
    expect(bootstrap).toHaveLength(9);
    expect(bootstrapChars).toBeLessThan(20_000);
    expect(bootstrapChars / allChars).toBeLessThan(0.30);
  });
});
