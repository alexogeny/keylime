import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import projectPlannerExtension from "../extensions/project-planner";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";
import { clearContextProviders, composeTurnContext } from "../extensions/shared/turn-context";
import { bindRepositoryState, resolveRepositoryIdentity } from "../extensions/shared/repository-identity";

function registeredProjectPlanner() {
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  projectPlannerExtension({
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: () => {},
  } as any);
  return { tools, commands };
}

const basePlan = {
  name: "Keylime Test Project",
  description: "A project for planner tests",
  stack: { language: "TypeScript", runtime: "Bun", testFramework: "bun:test" },
  principles: ["TDD", "functional style"],
  features: [{
    name: "Safety classifier",
    description: "Classify tool mutations",
    acceptanceCriteria: ["runtime eval is blocked", "dry runs do not mutate"],
  }],
  open_questions: ["Which bypasses matter most?"],
};

describe("project planner tools", () => {
  test("save_project_plan persists project state and update_feature_tdd preserves status across resaves", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "project-planner-"));
    const { tools } = registeredProjectPlanner();

    const saved = await tools.save_project_plan.execute("id", basePlan, undefined, undefined, { cwd });
    expect(saved.details.featureCount).toBe(1);
    expect(saved.details.openQuestions).toBe(1);

    await tools.update_feature_tdd.execute("id", {
      feature_name: "safety",
      tdd_status: "red",
      notes: "tests/safety-policy.test.ts fails first",
    }, undefined, undefined, { cwd });

    await tools.save_project_plan.execute("id", {
      ...basePlan,
      description: "Updated description",
      features: [{ ...basePlan.features[0], acceptanceCriteria: ["new criterion"] }],
      open_questions: ["Which bypasses matter most?"],
    }, undefined, undefined, { cwd });

    const envelope = JSON.parse(await readFile(join(cwd, ".pi", "project.json"), "utf8"));
    const plan = envelope.payload;
    expect(envelope.repository.marker).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.description).toBe("Updated description");
    expect(plan.features[0]).toMatchObject({ name: "Safety classifier", tddStatus: "red", notes: "tests/safety-policy.test.ts fails first" });
    expect(plan.features[0].acceptanceCriteria).toEqual(["new criterion"]);
    expect(plan.questions).toHaveLength(1);
  });

  test("manage_question answers only open matching questions and log_decision appends ADRs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "project-planner-"));
    const { tools } = registeredProjectPlanner();
    await tools.save_project_plan.execute("id", basePlan, undefined, undefined, { cwd });

    await tools.manage_question.execute("id", {
      action: "answer",
      question: "bypasses",
      answer: "Prioritize shell/runtime bypasses.",
    }, undefined, undefined, { cwd });

    await expect(tools.manage_question.execute("id", {
      action: "answer",
      question: "bypasses",
      answer: "Answer twice",
    }, undefined, undefined, { cwd })).rejects.toThrow("Open question not found");

    const decision = await tools.log_decision.execute("id", {
      topic: "Use shared classifier",
      status: "accepted",
      decision: "Centralize mutation classification.",
      rationale: "Avoid policy drift.",
      consequences: ["Safer guards", "More coupling to classifier"],
      alternatives_considered: ["Duplicate regexes everywhere"],
    }, undefined, undefined, { cwd });

    const envelope = JSON.parse(await readFile(join(cwd, ".pi", "project.json"), "utf8"));
    const plan = envelope.payload;
    expect(envelope.repository.marker).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.details.index).toBe(1);
    expect(plan.questions[0]).toMatchObject({ status: "answered", answer: "Prioritize shell/runtime bypasses." });
    expect(plan.decisions[0]).toMatchObject({ index: 1, topic: "Use shared classifier", status: "accepted" });
  });

  test("project context provider emits volatile TDD state only when project capability is active", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "project-planner-"));
    const { tools } = registeredProjectPlanner();
    await tools.save_project_plan.execute("id", basePlan, undefined, undefined, { cwd });
    await tools.update_feature_tdd.execute("id", { feature_name: "classifier", tdd_status: "green" }, undefined, undefined, { cwd });

    setCurrentRoute(classifyIntent("hello"));
    const messages = [{ role: "user", content: "plan project tdd feature" }];
    expect((await composeTurnContext({ cwd } as any, messages)).providerIds).toEqual([]);

    setCurrentRoute(classifyIntent("plan project tdd feature"));
    const composed = await composeTurnContext({ cwd } as any, messages);
    expect(composed.messages[0].content).toContain("Project: Keylime Test Project");
    expect(composed.messages[0].content).toContain("Safety classifier [green]");
    clearContextProviders();
  });

  test("quarantines legacy and foreign project state from turn context", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "project-quarantine-"));
    const foreign = await mkdtemp(join(tmpdir(), "project-foreign-"));
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const legacy = {
      ...basePlan,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      decisions: [],
      questions: [],
      features: [],
    };
    await writeFile(join(cwd, ".pi", "project.json"), JSON.stringify(legacy), "utf8");
    const { commands } = registeredProjectPlanner();
    setCurrentRoute(classifyIntent("plan project tdd feature"));

    const legacyContext = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue planning" }]);
    expect(legacyContext.providerIds).not.toContain("project-planner");

    await commands["adopt-project-state"].handler("", {
      cwd,
      hasUI: true,
      ui: { confirm: async () => true, notify: () => {} },
    });
    const adoptedContext = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue planning" }]);
    expect(adoptedContext.providerIds).toContain("project-planner");

    clearContextProviders();
    const foreignIdentity = await resolveRepositoryIdentity(foreign);
    await writeFile(
      join(cwd, ".pi", "project.json"),
      JSON.stringify(bindRepositoryState(foreignIdentity, legacy)),
      "utf8",
    );
    registeredProjectPlanner();
    const foreignContext = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue planning" }]);
    expect(foreignContext.providerIds).not.toContain("project-planner");
  });
});
