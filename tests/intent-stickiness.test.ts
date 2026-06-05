import { describe, expect, test, beforeEach } from "bun:test";
import intentRouterExtension, { getActiveToolSetDiagnostics, resetIntentRoutingForTests, routeForPrompt, toolSetFingerprint } from "../extensions/intent-router";
import { getCurrentRoute, setCurrentRoute, classifyIntent } from "../extensions/shared/intent";
import { bestIntentCorpusMatch, INTENT_CORPUS, matchIntentCorpus, SWITCH_THRESHOLD, FOLLOWUP_STICKINESS_THRESHOLD } from "../extensions/shared/intent-corpus";

const allToolNames = [
  "bash", "read", "edit", "write", "code_search", "list_files", "inspect_json", "inspect_text_matches", "inspect_code_structure", "inspect_lines",
  "plan_code_replacements", "apply_code_replacements", "create_file", "create_directory", "run_checks", "retrieve_policy", "suggest_checks", "codemod_plan",
  "codemod_update_json", "codemod_add_import", "codemod_insert_test_case", "inspect_tool_result", "list_tool_results", "cleanup_tool_results",
  "commit_history", "see_file_commit_history", "git_status", "git_diff", "inspect_at_checkpoint", "remember", "recall_memories", "recall_entity", "list_memories",
  "web_search", "research_topic", "fetch_url", "save_project_plan", "update_feature_tdd", "lookup_shoe", "query_shoes",
];

function piFixture(active = ["code_search"]) {
  let activeTools = active;
  const commands: Record<string, any> = {};
  const notifications: string[] = [];
  return {
    pi: {
      getAllTools: () => allToolNames.map(name => ({ name })),
      getActiveTools: () => activeTools.map(name => ({ name })),
      setActiveTools: (names: string[]) => { activeTools = names; },
      on: () => {},
      registerCommand: (name: string, command: any) => { commands[name] = command; },
    } as any,
    commands,
    notifications,
    ctx: {
      ui: {
        setStatus: () => {},
        notify: (text: string) => { notifications.push(text); },
        theme: { fg: (_style: string, text: string) => text },
      },
    } as any,
  };
}

beforeEach(() => {
  resetIntentRoutingForTests();
  setCurrentRoute(classifyIntent(""));
});

describe("intent corpus", () => {
  test("contains a broad follow-up and explicit switch corpus", () => {
    const followups = INTENT_CORPUS.filter(entry => entry.kind === "followup").flatMap(entry => entry.examples);
    const switches = INTENT_CORPUS.filter(entry => entry.kind === "switch").flatMap(entry => entry.examples);
    expect(followups.length).toBeGreaterThanOrEqual(60);
    expect(switches.length).toBeGreaterThanOrEqual(90);
    expect(new Set(INTENT_CORPUS.map(entry => entry.id)).size).toBe(INTENT_CORPUS.length);
  });

  test("matches follow-up and explicit switch examples above thresholds", () => {
    expect(bestIntentCorpusMatch("continue", "followup")?.score).toBeGreaterThanOrEqual(FOLLOWUP_STICKINESS_THRESHOLD);
    expect(bestIntentCorpusMatch("search the web for current sources", "switch")?.targetIntent).toBe("research");
    expect(bestIntentCorpusMatch("search the web for current sources", "switch")?.score).toBeGreaterThanOrEqual(SWITCH_THRESHOLD);
    expect(bestIntentCorpusMatch("remember this preference", "switch")?.targetIntent).toBe("memory");
  });

  test("does not confuse unrelated vague chat with sticky follow-up", () => {
    const match = matchIntentCorpus("what is your favorite color", { kind: "followup", topK: 1 })[0];
    expect(match?.score ?? 0).toBeLessThan(FOLLOWUP_STICKINESS_THRESHOLD);
  });
});

describe("route stickiness and explicit switches", () => {
  test("coding route sticks on low-confidence follow-up", () => {
    const { pi } = piFixture();
    routeForPrompt(pi, "implement this feature and add tests");
    const followup = routeForPrompt(pi, "continue");

    expect(followup.primaryIntent).toBe("coding");
    expect(getActiveToolSetDiagnostics().source).toBe("sticky");
    expect(getActiveToolSetDiagnostics().stickyFrom?.id).toBe("followup.continue");
  });

  test("research route sticks on follow-up but explicit coding switch wins", () => {
    const { pi } = piFixture();
    routeForPrompt(pi, "search the web for recent browser agent research");
    expect(getCurrentRoute().primaryIntent).toBe("research");

    const followup = routeForPrompt(pi, "go on");
    expect(followup.primaryIntent).toBe("research");
    expect(getActiveToolSetDiagnostics().source).toBe("sticky");

    const coding = routeForPrompt(pi, "actually edit the code now and add tests");
    expect(coding.primaryIntent).toBe("coding");
    expect(getActiveToolSetDiagnostics().source).not.toBe("sticky");
  });

  test("memory and research switches are not suppressed by previous coding route", () => {
    const { pi } = piFixture();
    routeForPrompt(pi, "fix this failing test in the repo");

    const memory = routeForPrompt(pi, "remember this preference for future runs");
    expect(memory.primaryIntent).toBe("memory");
    expect(getActiveToolSetDiagnostics().source).not.toBe("sticky");

    const research = routeForPrompt(pi, "search the web for the latest docs");
    expect(research.primaryIntent).toBe("research");
    expect(getActiveToolSetDiagnostics().source).toBe("classifier");
  });

  test("no previous non-chat route means follow-up does not invent coding", () => {
    const { pi } = piFixture();
    const route = routeForPrompt(pi, "continue");
    expect(route.primaryIntent).toBe("chat");
    expect(getActiveToolSetDiagnostics().source).not.toBe("sticky");
  });

  test("tool set fingerprint is stable for same names regardless ordering", () => {
    const a = toolSetFingerprint(["run_checks", "code_search", "inspect_lines"]);
    const b = toolSetFingerprint(["inspect_lines", "run_checks", "code_search"]);
    const c = toolSetFingerprint(["inspect_lines", "run_checks", "web_search"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("manual intent override", () => {
  test("/intent can force research, coding, chat, and auto", async () => {
    const fixture = piFixture();
    intentRouterExtension(fixture.pi);

    await fixture.commands.intent.handler("research", fixture.ctx);
    expect(routeForPrompt(fixture.pi, "continue").primaryIntent).toBe("research");
    expect(getActiveToolSetDiagnostics().source).toBe("manual");

    await fixture.commands.intent.handler("coding", fixture.ctx);
    expect(routeForPrompt(fixture.pi, "continue").primaryIntent).toBe("coding");

    await fixture.commands.intent.handler("chat", fixture.ctx);
    expect(routeForPrompt(fixture.pi, "implement this").primaryIntent).toBe("chat");

    await fixture.commands.intent.handler("auto", fixture.ctx);
    expect(routeForPrompt(fixture.pi, "implement this").primaryIntent).toBe("coding");
    expect(fixture.notifications.join("\n")).toContain("Automatic routing enabled");
  });

  test("agent status reports source, fingerprint, manual override, and change flag", async () => {
    const fixture = piFixture();
    intentRouterExtension(fixture.pi);
    routeForPrompt(fixture.pi, "implement this feature");
    await fixture.commands["agent-status"].handler("", fixture.ctx);

    const status = fixture.notifications.at(-1) ?? "";
    expect(status).toContain("tool set fingerprint:");
    expect(status).toContain("route source:");
    expect(status).toContain("tool set changed this turn:");
    expect(status).toContain("manual override: none");
  });
});
