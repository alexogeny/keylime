/**
 * Project Planner Extension
 *
 * Structured software project planning with TDD workflow, architectural
 * decision records, and web-search-backed stack research.
 *
 * Project state lives in <project-root>/.pi/project.json as local Pi state.
 * It is intentionally ignored by checkpoints. The extension walks up from ctx.cwd
 * to find the nearest project file.
 *
 * Tools registered:
 *   save_project_plan       — create or fully update a project plan
 *   update_feature_tdd      — advance a feature through RED→GREEN→REFACTOR→DONE
 *   log_decision            — record an architectural decision (ADR-style)
 *   manage_question         — add open questions or record their answers
 *
 * Commands:
 *   /new-project            — guided project kick-off session
 *   /project-status         — print current plan summary
 *   /tdd <feature>          — start a TDD cycle for a named feature
 *   /research-stack         — research contemporary best practices for the stack
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { stringEnum } from "./shared/schema";
import { readJsonFile, writeJsonFile } from "./shared/json-store";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isCapabilityActive } from "./shared/intent";
import { registerContextProvider } from "./shared/turn-context";
import { bindRepositoryState, loadBoundRepositoryState, resolveRepositoryIdentity } from "./shared/repository-identity";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TechStack {
  language:      string;
  runtime?:      string;
  framework?:    string;
  testFramework?: string;
  uiFramework?:  string;
  database?:     string;
  other?:        string[];
}

type TddStatus = "pending" | "red" | "green" | "refactored" | "done";

interface Feature {
  id:                 string;
  name:               string;
  description:        string;
  acceptanceCriteria: string[];
  tddStatus:          TddStatus;
  notes?:             string;
  updatedAt:          number;
}

type AdrStatus = "proposed" | "accepted" | "superseded" | "deprecated";

interface Decision {
  id:            string;
  index:         number;
  topic:         string;
  status:        AdrStatus;
  decision:      string;
  rationale:     string;
  consequences?: string[];
  alternatives?: string[];
  supersedes?:   number;
  timestamp:     number;
}

interface Question {
  id:        string;
  question:  string;
  answer?:   string;
  status:    "open" | "answered";
  timestamp: number;
}

interface ProjectPlan {
  name:        string;
  description: string;
  createdAt:   number;
  updatedAt:   number;
  stack:       TechStack;
  principles:  string[];
  features:    Feature[];
  decisions:   Decision[];
  questions:   Question[];
}

// ─── File helpers ──────────────────────────────────────────────────────────────

const PI_DIR      = ".pi";
const PROJECT_FILE = "project.json";

/** Walk up from cwd to find the nearest .pi/project.json */
async function findProjectFile(cwd: string): Promise<string | null> {
  const homeProject = join(homedir(), PI_DIR, PROJECT_FILE);
  let dir = cwd;
  while (true) {
    const candidate = join(dir, PI_DIR, PROJECT_FILE);
    if (existsSync(candidate)) {
      // Ignore global home-level project context unless user is explicitly inside a repo project.
      if (candidate !== homeProject) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

async function loadProject(cwd: string): Promise<ProjectPlan | null> {
  const file = await findProjectFile(cwd);
  if (!file) return null;
  const raw = await readJsonFile<unknown>(file, null);
  const identity = await resolveRepositoryIdentity(cwd);
  const loaded = loadBoundRepositoryState<ProjectPlan>(raw, identity, file);
  return loaded.status === "ok" ? loaded.value : null;
}

async function saveProject(cwd: string, plan: ProjectPlan): Promise<string> {
  const dir  = join(cwd, PI_DIR);
  const file = join(dir, PROJECT_FILE);
  plan.updatedAt = Date.now();
  const identity = await resolveRepositoryIdentity(cwd);
  await writeJsonFile(file, bindRepositoryState(identity, plan, plan.updatedAt));
  return file;
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

const TDD_ICON: Record<TddStatus, string> = {
  pending:    "○",
  red:        "🔴",
  green:      "🟢",
  refactored: "🔵",
  done:       "✓",
};

function isProjectPlan(value: unknown): value is ProjectPlan {
  const candidate = value as ProjectPlan | undefined;
  return typeof candidate?.name === "string"
    && typeof candidate.description === "string"
    && Array.isArray(candidate.features)
    && Array.isArray(candidate.decisions)
    && Array.isArray(candidate.questions)
    && Array.isArray(candidate.principles);
}

function renderPlan(p: ProjectPlan): string {
  const lines: string[] = [
    `## Project: ${p.name}`,
    p.description,
    ``,
    `### Tech Stack`,
    `  Language:   ${p.stack.language}`,
    p.stack.runtime      ? `  Runtime:    ${p.stack.runtime}` : "",
    p.stack.framework    ? `  Framework:  ${p.stack.framework}` : "",
    p.stack.testFramework? `  Tests:      ${p.stack.testFramework}` : "",
    p.stack.uiFramework  ? `  UI:         ${p.stack.uiFramework}` : "",
    p.stack.database     ? `  Database:   ${p.stack.database}` : "",
    p.stack.other?.length? `  Other:      ${p.stack.other.join(", ")}` : "",
    ``,
    `### Principles`,
    ...p.principles.map(pr => `  • ${pr}`),
    ``,
    `### Features (${p.features.length})`,
    ...p.features.map(f =>
      `  ${TDD_ICON[f.tddStatus]} [${f.tddStatus.padEnd(10)}] ${f.name}`
    ),
  ];

  const openQ = p.questions.filter(q => q.status === "open");
  if (openQ.length) {
    lines.push(``, `### Open Questions (${openQ.length})`);
    openQ.forEach(q => lines.push(`  ? ${q.question}`));
  }

  const recent = p.decisions.slice(-3);
  if (recent.length) {
    lines.push(``, `### Recent Decisions`);
    recent.forEach(d => lines.push(`  • ${d.topic}: ${d.decision}`));
  }

  return lines.filter(l => l !== "").join("\n");
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function projectPlannerExtension(pi: ExtensionAPI) {

  // ── System-prompt injection (STATIC content only) ──────────────────────────
  //
  // CACHE NOTE: feature TDD statuses and open questions change frequently.
  // They used to sit inside this system-prompt block, breaking the KV cache on
  // every status update. They are now routed through turn-context-composer as
  // capped volatile context.
  //
  // What stays here (stable for the life of the project):
  //   project name, description, stack, principles, TDD guide, skill guidance
  //
  // What moved to context (changes per feature transition):
  //   feature TDD statuses, open questions

  pi.on("before_agent_start", async (event, ctx) => {
    if (!isCapabilityActive("project")) return;
    const plan = await loadProject(ctx.cwd);
    if (!plan) return;

    const tddGuide = plan.principles.some(p => p.toLowerCase().includes("tdd"))
      ? `\nTDD cycle: invoke /skill:test-audit to turn acceptance criteria into a behavior/risk matrix, write a failing test (RED), implement minimal code to pass (GREEN), invoke /skill:test-audit again to spot missing edge cases beyond coverage %, clean up (REFACTOR), commit, repeat.`
      : "";

    const funcGuide = plan.principles.some(p => p.toLowerCase().includes("functional"))
      ? `\nFunctional style: prefer pure functions, immutable data, isolated side-effects. Avoid classes unless strongly justified.`
      : "";

    const block = [
      `\n\n## Active Project: ${plan.name}`,
      plan.description,
      ``,
      `Stack: ${[
        plan.stack.language,
        plan.stack.framework,
        plan.stack.testFramework,
        plan.stack.uiFramework,
        plan.stack.database,
        ...(plan.stack.other ?? []),
      ].filter(Boolean).join(" · ")}`,
      ``,
      `Principles: ${plan.principles.join(", ")}`,
      tddGuide,
      funcGuide,
      ``,
      `Use /skill:clarify to surface requirements, /skill:ui-design for interface work.`,
      `Call update_feature_tdd to record TDD progress. Call log_decision for architectural choices.`,
    ].filter(l => l !== "").join("\n");

    return { systemPrompt: event.systemPrompt + block };
  });

  // ── Context provider: volatile feature status + open questions ──────────────
  // Feature state changes frequently, so turn-context-composer injects a capped
  // per-turn summary only when project capability is active.

  registerContextProvider({
    id: "project-planner",
    priority: 70,
    maxChars: 420,
    applies: () => isCapabilityActive("project"),
    build: async ({ ctx }) => {
      const plan = await loadProject(ctx.cwd);
      if (!plan) return null;

      const openQ = plan.questions.filter(q => q.status === "open");
      const active = plan.features.filter(f => f.tddStatus !== "pending").slice(0, 6);
      const pendingCount = plan.features.filter(f => f.tddStatus === "pending").length;
      const shown = active.length > 0 ? active : plan.features.slice(0, 4);

      return [
        `Project: ${plan.name}`,
        shown.length ? `Features:\n${shown.map(f => `  ${TDD_ICON[f.tddStatus]} ${f.name} [${f.tddStatus}]`).join("\n")}` : "",
        pendingCount > shown.filter(f => f.tddStatus === "pending").length ? `  … ${pendingCount} pending hidden` : "",
        openQ.length ? `Open questions:\n${openQ.slice(0, 3).map(q => `  ? ${q.question}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");
    },
  });

  pi.registerCommand("adopt-project-state", {
    description: "Adopt quarantined project state into the current repository",
    handler: async (_args, ctx) => {
      const file = await findProjectFile(ctx.cwd);
      if (!file) {
        ctx.ui.notify("No project state found to adopt.", "warning");
        return;
      }
      const raw = await readJsonFile<unknown>(file, null);
      const identity = await resolveRepositoryIdentity(ctx.cwd);
      const loaded = loadBoundRepositoryState<ProjectPlan>(raw, identity, file);
      if (loaded.status === "ok") {
        ctx.ui.notify("Project state is already bound to this repository.", "info");
        return;
      }
      const candidate = loaded.status === "mismatch" ? loaded.quarantinedValue : raw;
      if (!isProjectPlan(candidate)) {
        ctx.ui.notify("Quarantined project state is not a valid project plan.", "error");
        return;
      }
      if (!ctx.hasUI || !(await ctx.ui.confirm("Adopt project state?", `Bind ${file} to the current repository. A backup will be retained.`))) return;
      await writeJsonFile(`${file}.backup-${Date.now()}`, raw, { finalNewline: true });
      await writeJsonFile(file, bindRepositoryState(identity, candidate), { finalNewline: true });
      ctx.ui.notify("Project state adopted for this repository.", "info");
    },
  });

  // ── Tool: save_project_plan ──────────────────────────────────────────────────
  pi.registerTool({
    name:        "save_project_plan",
    label:       "Save Project Plan",
    description: "Create or replace .pi/project.json with stack, principles, features, and questions.",
    promptSnippet: "Create/update the project plan",
    promptGuidelines: ["Use for new projects or major plan changes."],
    parameters: Type.Object({
      name:        Type.String({ description: "Project name" }),
      description: Type.String({ description: "One paragraph describing what the project does and for whom" }),
      stack: Type.Object({
        language:       Type.String({ description: "Primary language" }),
        runtime:        Type.Optional(Type.String({ description: "Runtime" })),
        framework:      Type.Optional(Type.String({ description: "Backend framework" })),
        testFramework:  Type.Optional(Type.String({ description: "Test framework" })),
        uiFramework:    Type.Optional(Type.String({ description: "UI framework" })),
        database:       Type.Optional(Type.String({ description: "Database" })),
        other:          Type.Optional(Type.Array(Type.String(), { description: "Other tools" })),
      }),
      principles: Type.Array(Type.String(), { description: "Coding principles" }),
      features: Type.Array(
        Type.Object({
          name:               Type.String(),
          description:        Type.String(),
          acceptanceCriteria: Type.Array(Type.String(), { description: "Concrete, testable criteria" }),
        }),
        { description: "All planned features; TDD status starts as 'pending'" }
      ),
      open_questions: Type.Optional(Type.Array(Type.String(), {
        description: "Unanswered questions that should be resolved before/during implementation",
      })),
    }),

    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Saving project plan for "${params.name}"…` }], details: {} });

      const existing = await loadProject(ctx.cwd);
      const now      = Date.now();

      // Merge features: preserve TDD status for existing features by name
      const existingByName = new Map(existing?.features.map(f => [f.name.toLowerCase(), f]) ?? []);

      const features: Feature[] = params.features.map(f => {
        const prev = existingByName.get(f.name.toLowerCase());
        return {
          id:                 prev?.id ?? randomUUID(),
          name:               f.name,
          description:        f.description,
          acceptanceCriteria: f.acceptanceCriteria,
          tddStatus:          prev?.tddStatus ?? "pending",
          notes:              prev?.notes,
          updatedAt:          prev?.updatedAt ?? now,
        };
      });

      const questions: Question[] = [
        ...(existing?.questions ?? []),
        ...(params.open_questions ?? [])
          .filter(q => !existing?.questions.some(eq => eq.question === q))
          .map(q => ({ id: randomUUID(), question: q, status: "open" as const, timestamp: now })),
      ];

      const plan: ProjectPlan = {
        name:        params.name,
        description: params.description,
        createdAt:   existing?.createdAt ?? now,
        updatedAt:   now,
        stack:       params.stack,
        principles:  params.principles,
        features,
        decisions:   existing?.decisions ?? [],
        questions,
      };

      const file = await saveProject(ctx.cwd, plan);

      return {
        content: [{
          type: "text",
          text: [
            `✓ Project plan saved to ${file}`,
            ``,
            renderPlan(plan),
            ``,
            `Next steps:`,
            `  1. Resolve any open questions (/skill:clarify)`,
            `  2. Research stack for contemporary patterns (/research-stack)`,
            `  3. Start first TDD cycle (/tdd <feature-name>)`,
          ].join("\n"),
        }],
        details: { file, featureCount: features.length, openQuestions: questions.filter(q => q.status === "open").length },
      };
    },
  });

  // ── Tool: update_feature_tdd ─────────────────────────────────────────────────
  pi.registerTool({
    name:        "update_feature_tdd",
    label:       "Update Feature TDD Status",
    description: "Advance a feature TDD status.",
    promptSnippet: "Record TDD progress",
    promptGuidelines: ["Use at red, green, refactored, and done transitions."],
    parameters: Type.Object({
      feature_name: Type.String({ description: "Feature name (partial match OK)" }),
      tdd_status:   stringEnum(["red", "green", "refactored", "done"] as const, {
        description: "New TDD status: red=test written+failing, green=tests pass, refactored=clean, done=committed",
      }),
      notes: Type.Optional(Type.String({ description: "What was done at this stage, key decisions, test names, etc." })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const plan = await loadProject(ctx.cwd);
      if (!plan) throw new Error("No project plan found. Run save_project_plan first.");

      const query  = params.feature_name.toLowerCase();
      const feature = plan.features.find(f => f.name.toLowerCase().includes(query));
      if (!feature) {
        throw new Error(
          `Feature not found: "${params.feature_name}". Available: ${plan.features.map(f => f.name).join(", ")}`
        );
      }

      const prev       = feature.tddStatus;
      feature.tddStatus = params.tdd_status;
      feature.notes     = params.notes ?? feature.notes;
      feature.updatedAt = Date.now();

      await saveProject(ctx.cwd, plan);

      const icon    = TDD_ICON[params.tdd_status];
      const nextStep: Record<TddStatus, string> = {
        pending:    "Write a failing test to enter RED",
        red:        "Write minimal code to make the test pass → GREEN",
        green:      "Refactor while keeping tests green → REFACTORED",
        refactored: "Commit and mark as DONE",
        done:       "Pick the next feature from the backlog",
      };

      return {
        content: [{
          type: "text",
          text: [
            `${icon} ${feature.name}: ${prev} → ${params.tdd_status}`,
            params.notes ? `Notes: ${params.notes}` : "",
            ``,
            `Next: ${nextStep[params.tdd_status]}`,
            ``,
            `Backlog:`,
            ...plan.features.map(f => `  ${TDD_ICON[f.tddStatus]} ${f.name} [${f.tddStatus}]`),
          ].filter(l => l !== "").join("\n"),
        }],
        details: { feature: feature.name, from: prev, to: params.tdd_status },
      };
    },
  });

  // ── Tool: log_decision ───────────────────────────────────────────────────────
  pi.registerTool({
    name:        "log_decision",
    label:       "Log Architectural Decision",
    description: "Write an ADR and store it in the project plan.",
    promptSnippet: "Record an architectural decision",
    promptGuidelines: ["Use for non-trivial choices; document why and consequences."],
    parameters: Type.Object({
      topic:        Type.String({ description: "Short title, e.g. 'Use Zod for validation', 'PostgreSQL over SQLite'" }),
      status:       stringEnum(["proposed", "accepted", "superseded", "deprecated"] as const, {
        description: "ADR status. Use 'accepted' for finalised decisions.",
      }),
      decision:     Type.String({ description: "What was decided (one clear sentence)" }),
      rationale:    Type.String({ description: "Why — the context, forces, and reasoning behind the decision" }),
      consequences: Type.Optional(Type.Array(Type.String(), {
        description: "What becomes easier, harder, or constrained. Include positive AND negative consequences.",
      })),
      alternatives_considered: Type.Optional(Type.Array(Type.String(), {
        description: "Other options evaluated and why they were not chosen",
      })),
      supersedes: Type.Optional(Type.Number({ description: "ADR index number this decision replaces, if any" })),
    }),

    async execute(_id, params, _signal, onUpdate, ctx) {
      const plan = await loadProject(ctx.cwd);
      if (!plan) throw new Error("No project plan found. Run save_project_plan first.");

      const index   = plan.decisions.length + 1;
      const padded  = String(index).padStart(4, "0");
      const slug    = params.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const filename = `${padded}-${slug}.md`;

      const decision: Decision = {
        id:           randomUUID(),
        index,
        topic:        params.topic,
        status:       params.status,
        decision:     params.decision,
        rationale:    params.rationale,
        consequences: params.consequences,
        alternatives: params.alternatives_considered,
        supersedes:   params.supersedes,
        timestamp:    Date.now(),
      };

      plan.decisions.push(decision);
      await saveProject(ctx.cwd, plan);

      // Write MADR .md to docs/decisions/
      const docsDir  = join(ctx.cwd, "docs", "decisions");
      await mkdir(docsDir, { recursive: true });

      const madrLines: string[] = [
        `# ${padded}. ${params.topic}`,
        ``,
        `Date: ${new Date(decision.timestamp).toISOString().slice(0, 10)}`,
        `Status: ${String(params.status).charAt(0).toUpperCase() + String(params.status).slice(1)}`,
      ];
      if (params.supersedes != null)
        madrLines.push(`Supersedes: ADR-${String(params.supersedes).padStart(4, "0")}`);
      madrLines.push(
        ``, `## Context`, ``, params.rationale,
        ``, `## Decision`, ``, params.decision,
        ``, `## Consequences`, ``,
        ...(params.consequences?.map(c => `- ${c}`) ?? ["- (none documented)"]),
      );
      if (params.alternatives_considered?.length) {
        madrLines.push(``, `## Alternatives Considered`, ``);
        params.alternatives_considered.forEach(a => madrLines.push(`- ${a}`));
      }

      const madrPath = join(docsDir, filename);
      await writeFile(madrPath, madrLines.join("\n") + "\n", "utf8");
      onUpdate?.({ content: [{ type: "text", text: `Writing ${madrPath}...` }], details: {} });

      return {
        content: [{
          type: "text",
          text: [
            `✓ ADR-${padded}: ${params.topic} [${params.status}]`,
            `  Decision:     ${params.decision}`,
            params.consequences?.length
              ? `  Consequences: ${params.consequences.join("; ")}`
              : "",
            params.alternatives_considered?.length
              ? `  Alternatives: ${params.alternatives_considered.join(", ")}`
              : "",
            ``,
            `File: docs/decisions/${filename}`,
            `Total ADRs: ${plan.decisions.length}`,
          ].filter(l => l !== "").join("\n"),
        }],
        details: { id: decision.id, index, filename, topic: params.topic, status: params.status },
      };
    },
  });

  // ── Tool: manage_question ────────────────────────────────────────────────────
  pi.registerTool({
    name:        "manage_question",
    label:       "Manage Clarifying Question",
    description: "Add or answer a project question.",
    promptSnippet: "Manage project questions",
    parameters: Type.Object({
      action:   stringEnum(["add", "answer"] as const),
      question: Type.String({ description: "The question text (for add), or partial match of existing question (for answer)" }),
      answer:   Type.Optional(Type.String({ description: "The answer (required when action=answer)" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const plan = await loadProject(ctx.cwd);
      if (!plan) throw new Error("No project plan found. Run save_project_plan first.");

      if (params.action === "add") {
        const q: Question = {
          id:        randomUUID(),
          question:  params.question,
          status:    "open",
          timestamp: Date.now(),
        };
        plan.questions.push(q);
        await saveProject(ctx.cwd, plan);
        return {
          content: [{ type: "text", text: `? Question added: ${params.question}\n\nOpen questions: ${plan.questions.filter(q => q.status === "open").length}` }],
          details: { id: q.id, action: "add" },
        };
      } else {
        if (!params.answer) throw new Error("answer is required when action=answer");
        const query = params.question.toLowerCase();
        const q     = plan.questions.find(q => q.status === "open" && q.question.toLowerCase().includes(query));
        if (!q) throw new Error(`Open question not found matching: "${params.question}"`);
        q.answer = params.answer;
        q.status = "answered";
        await saveProject(ctx.cwd, plan);
        return {
          content: [{ type: "text", text: `✓ Answered: ${q.question}\n   → ${params.answer}\n\nOpen questions remaining: ${plan.questions.filter(q => q.status === "open").length}` }],
          details: { id: q.id, action: "answer" },
        };
      }
    },
  });

  // ── /new-project command ─────────────────────────────────────────────────────
  pi.registerCommand("new-project", {
    description: "Start a structured project planning session for the current directory",
    handler: async (_args, ctx) => {
      const existing = await loadProject(ctx.cwd);
      if (existing) {
        const ok = await ctx.ui.confirm(
          "Project already exists",
          `Found existing plan for "${existing.name}". Start over?`,
        );
        if (!ok) {
          ctx.ui.notify(`Keeping existing plan for "${existing.name}"`, "info");
          return;
        }
      }
      pi.sendUserMessage(
        [
          `Let's plan a new software project. Please guide me through the following in order:`,
          ``,
          `**1. Project Overview**`,
          `Ask me what the project does, who it's for, and what problem it solves.`,
          ``,
          `**2. Technology Stack**`,
          `Based on my answers, suggest a contemporary, well-suited tech stack.`,
          `Use web search (web_search + save_search_knowledge) to verify the stack choices are current best practice for this use case.`,
          `Confirm choices with me before proceeding.`,
          ``,
          `**3. Coding Principles**`,
          `We write functional-style code: pure functions, immutable data, side-effects isolated at the edges.`,
          `We use TDD: red → green → refactor → commit. Confirm any additions.`,
          ``,
          `**4. Feature Breakdown**`,
          `Help me break the project into discrete features with clear acceptance criteria.`,
          `Each criterion should be concrete and testable.`,
          `Use /skill:clarify if any requirements are ambiguous.`,
          ``,
          `**5. Open Questions**`,
          `List anything we need to resolve before or during implementation.`,
          ``,
          `When we have a complete picture, call save_project_plan with everything.`,
        ].join("\n"),
        { deliverAs: "followUp" },
      );
    },
  });

  // ── /project-status command ──────────────────────────────────────────────────
  pi.registerCommand("project-status", {
    description: "Show a summary of the current project plan and TDD progress",
    handler: async (_args, ctx) => {
      const plan = await loadProject(ctx.cwd);
      if (!plan) {
        ctx.ui.notify("No project plan found in this directory. Run /new-project to start one.", "warning");
        return;
      }

      const done        = plan.features.filter(f => f.tddStatus === "done").length;
      const inProgress  = plan.features.filter(f => !["pending","done"].includes(f.tddStatus)).length;
      const pending     = plan.features.filter(f => f.tddStatus === "pending").length;
      const openQ       = plan.questions.filter(q => q.status === "open").length;

      ctx.ui.notify(
        [
          `${plan.name}`,
          `Features: ${done}✓ done · ${inProgress} in progress · ${pending} pending`,
          `Decisions: ${plan.decisions.length}  Open questions: ${openQ}`,
          `Stack: ${[plan.stack.language, plan.stack.framework, plan.stack.testFramework].filter(Boolean).join(" / ")}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // ── /tdd command ─────────────────────────────────────────────────────────────
  pi.registerCommand("tdd", {
    description: "Start a TDD cycle for a feature: /tdd <feature name>",
    handler: async (args, ctx) => {
      const featureName = args?.trim();
      if (!featureName) {
        ctx.ui.notify("Usage: /tdd <feature name>", "warning");
        return;
      }
      const plan = await loadProject(ctx.cwd);
      if (!plan) {
        ctx.ui.notify("No project plan found. Run /new-project first.", "warning");
        return;
      }

      const query   = featureName.toLowerCase();
      const feature = plan.features.find(f => f.name.toLowerCase().includes(query));
      if (!feature) {
        ctx.ui.notify(`Feature not found: "${featureName}". Available: ${plan.features.map(f => f.name).join(", ")}`, "warning");
        return;
      }

      pi.sendUserMessage(
        [
          `Let's do a TDD cycle for: **${feature.name}**`,
          ``,
          `Description: ${feature.description}`,
          ``,
          `Acceptance criteria:`,
          feature.acceptanceCriteria.map(c => `  - ${c}`).join("\n"),
          ``,
          `Current status: ${TDD_ICON[feature.tddStatus]} ${feature.tddStatus}`,
          ``,
          `**TDD Protocol:**`,
          ``,
          `**🔴 RED** — Write the smallest possible failing test that captures one acceptance criterion.`,
          `  • Test name should read as a specification: \`it("should ...")\``,
          `  • Run the test suite and confirm it fails for the right reason`,
          `  • Call update_feature_tdd(feature_name="${feature.name}", tdd_status="red", notes=<test description>)`,
          ``,
          `**🟢 GREEN** — Write the minimum code to make that test pass. No more.`,
          `  • Run tests, confirm green`,
          `  • Call update_feature_tdd(feature_name="${feature.name}", tdd_status="green")`,
          ``,
          `**🔵 REFACTOR** — Clean up without changing behaviour. Tests stay green.`,
          `  • Extract functions, clarify names, remove duplication`,
          `  • Call update_feature_tdd(feature_name="${feature.name}", tdd_status="refactored")`,
          ``,
          `**✓ DONE** — Commit, then pick the next criterion or next feature.`,
          `  • Call update_feature_tdd(feature_name="${feature.name}", tdd_status="done")`,
          ``,
          `Functional style reminders:`,
          `  • Pure functions preferred — same input → same output, no hidden state`,
          `  • Data flows through functions, not stored in objects/classes`,
          `  • Side-effects (IO, DB, network) pushed to the edges of the call graph`,
          ``,
          `Start with the first uncovered acceptance criterion. Shall we begin?`,
        ].join("\n"),
        { deliverAs: "followUp" },
      );
    },
  });

  // ── /research-stack command ──────────────────────────────────────────────────
  pi.registerCommand("research-stack", {
    description: "Research contemporary best practices for the current project's tech stack",
    handler: async (_args, ctx) => {
      const plan = await loadProject(ctx.cwd);
      if (!plan) {
        ctx.ui.notify("No project plan found. Run /new-project first.", "warning");
        return;
      }

      const stack = [
        plan.stack.language,
        plan.stack.framework,
        plan.stack.testFramework,
        plan.stack.uiFramework,
        plan.stack.database,
        ...(plan.stack.other ?? []),
      ].filter(Boolean).join(", ");

      pi.sendUserMessage(
        [
          `Research contemporary best practices for our project stack and validate our choices are current.`,
          ``,
          `**Project:** ${plan.name}`,
          `**Stack:** ${stack}`,
          ``,
          `Please:`,
          `1. Check recall_web_knowledge for anything already known about these technologies`,
          `2. Search for contemporary patterns and gotchas for each key stack component in ${new Date().getFullYear()}`,
          `3. Specifically look for: recommended project structure, any deprecated patterns to avoid, emerging community conventions`,
          `4. Save everything with save_search_knowledge`,
          `5. Summarise findings and flag any concerns about our stack choices`,
          `6. Call log_decision for any changes we should make based on research`,
        ].join("\n"),
        { deliverAs: "followUp" },
      );
    },
  });

  // ── Status bar ───────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const plan = await loadProject(ctx.cwd);
    if (!plan) {
      ctx.ui.setStatus("project", "📋 no project — /new-project");
      return;
    }
    const done    = plan.features.filter(f => f.tddStatus === "done").length;
    const total   = plan.features.length;
    const current = plan.features.find(f => ["red","green","refactored"].includes(f.tddStatus));
    const currentStr = current ? ` · ${TDD_ICON[current.tddStatus]}${current.name}` : "";
    ctx.ui.setStatus("project", `📋 ${plan.name} · ${done}/${total}✓${currentStr}`);
  });
}
