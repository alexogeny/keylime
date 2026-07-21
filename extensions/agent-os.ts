import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./shared/json-store";
import { clearTurnContextCache, registerContextProvider } from "./shared/turn-context";
import { truncateWithMarker } from "./shared/output-preview";
import { stringEnum } from "./shared/schema";
import { existsSync } from "node:fs";
import { bindRepositoryState, loadBoundRepositoryState, resolveRepositoryIdentity } from "./shared/repository-identity";

type RegionKind = "task" | "code" | "failure" | "policy" | "decision" | "scratch" | "checks" | "diff";
type ReasoningBudget = "low" | "medium" | "high" | "max";
type RiskLevel = "low" | "medium" | "high";

type AgentRegisters = {
  goal?: string;
  state?: string;
  hypothesis?: string;
  nextAction?: string;
  risks?: string[];
  doneWhen?: string[];
  blockedOn?: string;
};

type ContextRegion = {
  id: string;
  kind: RegionKind;
  content: string;
  priority: number;
  ttlTurns?: number;
  version: number;
  checksum: string;
  pinned?: boolean;
  sourceRefs?: string[];
  lastUsedAt?: number;
  createdAt: string;
  updatedAt: string;
};

type ToolGrammar = {
  id: string;
  allowedTools: string[];
  forbiddenTools: string[];
  allowedSequences: string[];
  requiredNext?: string[];
  stopConditions: string[];
  riskLevel: RiskLevel;
  compiledAt: string;
};

type AgentBudget = {
  maxContextChars: number;
  maxToolCalls: number;
  maxCheckRuns: number;
  maxBranchCount: number;
  reasoningBudget: ReasoningBudget;
};

type AgentOsState = {
  registers: AgentRegisters;
  regions: ContextRegion[];
  grammar?: ToolGrammar;
  budget: AgentBudget;
};

const DEFAULT_BUDGET: AgentBudget = {
  maxContextChars: 1800,
  maxToolCalls: 12,
  maxCheckRuns: 2,
  maxBranchCount: 0,
  reasoningBudget: "medium",
};

const STATE_FILE = join(".pi", "agent-os.json");
let activeContinuityTools = new Set<string>();
let activeRegisterRoutingText = "";

export function agentOsContinuityToolNames(): string[] {
  return [...activeContinuityTools].sort();
}

export function agentOsRoutingPromptSuffix(): string {
  return activeRegisterRoutingText;
}

export function resetAgentOsMemoryForTests(): void {
  activeContinuityTools = new Set();
  activeRegisterRoutingText = "";
}

function updateInMemoryAgentOs(state: AgentOsState): void {
  activeContinuityTools = new Set(state.grammar?.allowedTools ?? []);
  const registers = state.registers;
  activeRegisterRoutingText = [registers.goal, registers.state, registers.hypothesis, registers.nextAction, registers.blockedOn, ...(registers.risks ?? []), ...(registers.doneWhen ?? [])]
    .filter(Boolean)
    .join(" ");
}

function statePath(cwd: string): string {
  return join(cwd, STATE_FILE);
}

function defaultState(): AgentOsState {
  return { registers: {}, regions: [], budget: { ...DEFAULT_BUDGET } };
}

type AgentOsStateLoad = {
  status: "ok" | "missing" | "legacy" | "mismatch";
  state: AgentOsState;
};

function normalizeState(state: AgentOsState): AgentOsState {
  return {
    ...defaultState(),
    ...state,
    budget: { ...DEFAULT_BUDGET, ...(state as any).budget },
    regions: state.regions ?? [],
    registers: state.registers ?? {},
  };
}

async function loadStateRecord(cwd: string): Promise<AgentOsStateLoad> {
  const path = statePath(cwd);
  if (!existsSync(path)) {
    const state = defaultState();
    updateInMemoryAgentOs(state);
    return { status: "missing", state };
  }
  const raw = await readJsonFile<unknown>(path, null);
  const identity = await resolveRepositoryIdentity(cwd);
  const loaded = loadBoundRepositoryState<AgentOsState>(raw, identity, path);
  if (loaded.status !== "ok") {
    const state = defaultState();
    updateInMemoryAgentOs(state);
    return { status: loaded.status, state };
  }
  const state = normalizeState(loaded.value);
  updateInMemoryAgentOs(state);
  return { status: "ok", state };
}

async function loadState(cwd: string): Promise<AgentOsState> {
  const loaded = await loadStateRecord(cwd);
  if (loaded.status === "legacy" || loaded.status === "mismatch") {
    throw new Error("Agent OS state is quarantined for this repository; explicitly adopt or replace it before using agent state tools.");
  }
  return loaded.state;
}

async function saveState(cwd: string, state: AgentOsState): Promise<void> {
  updateInMemoryAgentOs(state);
  const identity = await resolveRepositoryIdentity(cwd);
  await writeJsonFile(statePath(cwd), bindRepositoryState(identity, state), { finalNewline: true });
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function isAgentOsState(value: unknown): value is AgentOsState {
  const candidate = value as AgentOsState | undefined;
  return Boolean(candidate)
    && typeof candidate?.registers === "object"
    && Array.isArray(candidate.regions)
    && typeof candidate.budget === "object";
}

function renderList(values: string[] | undefined): string {
  return values?.length ? values.join("; ") : "";
}

function renderRegisters(registers: AgentRegisters): string {
  const lines = [
    registers.goal ? `GOAL: ${registers.goal}` : "",
    registers.state ? `STATE: ${registers.state}` : "",
    registers.hypothesis ? `HYPOTHESIS: ${registers.hypothesis}` : "",
    registers.nextAction ? `NEXT_ACTION: ${registers.nextAction}` : "",
    registers.risks?.length ? `RISKS: ${renderList(registers.risks)}` : "",
    registers.doneWhen?.length ? `DONE_WHEN: ${renderList(registers.doneWhen)}` : "",
    registers.blockedOn ? `BLOCKED_ON: ${registers.blockedOn}` : "",
  ].filter(Boolean);
  return lines.length ? ["AGENT REGISTERS", ...lines].join("\n") : "";
}

function sortRegions(regions: ContextRegion[]): ContextRegion[] {
  return [...regions].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.priority - a.priority || b.version - a.version || a.id.localeCompare(b.id));
}

function renderRegion(region: ContextRegion, maxChars: number): string {
  return [
    `CTX REGION ctx://${region.id} kind=${region.kind} v${region.version} priority=${region.priority}${region.pinned ? " pinned" : ""} checksum=${region.checksum}`,
    region.sourceRefs?.length ? `refs: ${region.sourceRefs.join(", ")}` : "",
    truncateWithMarker(region.content, maxChars, "… [trimmed]"),
  ].filter(Boolean).join("\n");
}

function grammarFor(intent: string, riskLevel: RiskLevel): ToolGrammar {
  const now = new Date().toISOString();
  if (intent === "large_file_create") {
    return {
      id: "large_file_create",
      allowedTools: ["begin_file_write", "append_file_chunk", "finish_file_write", "abort_file_write", "run_checks"],
      forbiddenTools: ["bash", "create_file", "write", "edit"],
      allowedSequences: ["begin_file_write → append_file_chunk* → finish_file_write", "abort_file_write on cancellation/failure"],
      requiredNext: ["begin_file_write"],
      stopConditions: ["finish_file_write succeeds", "abort_file_write cleans up staged content"],
      riskLevel,
      compiledAt: now,
    };
  }
  if (intent === "document_read_summarize") {
    return {
      id: "document_read_summarize",
      allowedTools: ["inspect_document", "summarize_document", "inspect_spreadsheet", "extract_document_tables", "inspect_file_metadata", "ctx_region_write"],
      forbiddenTools: ["bash", "python", "node", "read", "write", "edit"],
      allowedSequences: ["inspect metadata/document → summarize scaffold → answer or store ctx region"],
      requiredNext: ["inspect_document", "summarize_document"],
      stopConditions: ["summary grounded in extracted text", "document extraction reports unsupported/scanned content"],
      riskLevel,
      compiledAt: now,
    };
  }
  if (intent === "reporter_document_create") {
    return {
      id: "reporter_document_create",
      allowedTools: ["inspect_document", "summarize_document", "inspect_spreadsheet", "create_reporter_document", "convert_document", "inspect_file_metadata", "run_checks"],
      forbiddenTools: ["bash", "python", "node", "write", "edit"],
      allowedSequences: ["gather source text/data → draft semantic sections → create_reporter_document → inspect metadata"],
      requiredNext: ["create_reporter_document"],
      stopConditions: ["reporter document created", "blocked by missing source content or output path"],
      riskLevel,
      compiledAt: now,
    };
  }
  if (intent === "existing_file_edit") {
    return {
      id: "existing_file_edit",
      allowedTools: ["code_search", "inspect_text_matches", "inspect_code_structure", "inspect_lines", "plan_code_replacements", "apply_code_replacements", "run_checks"],
      forbiddenTools: ["bash", "create_file", "write", "edit"],
      allowedSequences: ["search/match/structure → inspect_lines → plan_code_replacements → apply_code_replacements → run_checks"],
      requiredNext: ["code_search", "inspect_text_matches", "inspect_code_structure"],
      stopConditions: ["targeted checks pass", "no relevant exact replacement can be planned"],
      riskLevel,
      compiledAt: now,
    };
  }
  return {
    id: "safe_coding_default",
    allowedTools: ["code_search", "list_files", "inspect_text_matches", "inspect_code_structure", "inspect_lines", "inspect_document", "summarize_document", "inspect_spreadsheet", "plan_code_replacements", "apply_code_replacements", "create_file", "create_directory", "create_reporter_document", "run_checks"],
    forbiddenTools: ["write", "edit", "bash for file inspection/mutation"],
    allowedSequences: ["discover → inspect → plan → mutate → verify"],
    stopConditions: ["requested behavior verified", "blocked by missing requirements"],
    riskLevel,
    compiledAt: now,
  };
}

function budgetFor(riskLevel: RiskLevel, requested?: Partial<AgentBudget>): AgentBudget {
  const base: AgentBudget = riskLevel === "high"
    ? { maxContextChars: 2600, maxToolCalls: 20, maxCheckRuns: 3, maxBranchCount: 0, reasoningBudget: "high" }
    : riskLevel === "low"
      ? { maxContextChars: 1200, maxToolCalls: 8, maxCheckRuns: 1, maxBranchCount: 0, reasoningBudget: "low" }
      : { ...DEFAULT_BUDGET };
  return { ...base, ...requested, maxBranchCount: Math.min(Math.max(0, requested?.maxBranchCount ?? base.maxBranchCount), 2) };
}

function renderGrammar(grammar: ToolGrammar | undefined): string {
  if (!grammar) return "";
  return [
    `TOOL GRAMMAR ${grammar.id} risk=${grammar.riskLevel}`,
    `allowed: ${grammar.allowedTools.join(", ")}`,
    `forbidden: ${grammar.forbiddenTools.join(", ")}`,
    `sequence: ${grammar.allowedSequences.join(" | ")}`,
  ].join("\n");
}

function renderBudget(budget: AgentBudget): string {
  return `BUDGET context=${budget.maxContextChars} tool_calls=${budget.maxToolCalls} checks=${budget.maxCheckRuns} branches=${budget.maxBranchCount} reasoning=${budget.reasoningBudget}`;
}

export default function agentOsExtension(pi: ExtensionAPI) {
  registerContextProvider({
    id: "agent-os",
    priority: 95,
    maxChars: 1800,
    stability: "turn",
    build: async ({ ctx, remainingBudget }) => {
      const loaded = await loadStateRecord(ctx.cwd);
      if (loaded.status === "legacy" || loaded.status === "mismatch") return null;
      const state = loaded.state;
      const sections: string[] = [];
      const registers = renderRegisters(state.registers);
      if (registers) sections.push(registers);
      const regionBudget = Math.max(220, Math.min(700, Math.floor((remainingBudget - registers.length) / 3)));
      for (const region of sortRegions(state.regions).slice(0, 3)) sections.push(renderRegion(region, regionBudget));
      const grammar = renderGrammar(state.grammar);
      if (grammar) sections.push(grammar);
      sections.push(renderBudget(state.budget));
      return sections.filter(Boolean).join("\n\n");
    },
  });

  pi.registerCommand("adopt-agent-os-state", {
    description: "Adopt quarantined agent OS state into the current repository",
    handler: async (_args, ctx) => {
      const path = statePath(ctx.cwd);
      if (!existsSync(path)) {
        ctx.ui.notify("No agent OS state found to adopt.", "warning");
        return;
      }
      const raw = await readJsonFile<unknown>(path, null);
      const identity = await resolveRepositoryIdentity(ctx.cwd);
      const loaded = loadBoundRepositoryState<AgentOsState>(raw, identity, path);
      if (loaded.status === "ok") {
        ctx.ui.notify("Agent OS state is already bound to this repository.", "info");
        return;
      }
      const candidate = loaded.status === "mismatch" ? loaded.quarantinedValue : raw;
      if (!isAgentOsState(candidate)) {
        ctx.ui.notify("Quarantined agent OS state is invalid.", "error");
        return;
      }
      if (!ctx.hasUI || !(await ctx.ui.confirm("Adopt agent OS state?", `Bind ${path} to the current repository. A backup will be retained.`))) return;
      await writeJsonFile(`${path}.backup-${Date.now()}`, raw, { finalNewline: true });
      await saveState(ctx.cwd, normalizeState(candidate));
      clearTurnContextCache();
      ctx.ui.notify("Agent OS state adopted for this repository.", "info");
    },
  });

  pi.registerTool({
    name: "read_agent_registers",
    label: "Read Agent Registers",
    description: "Read compact cognitive registers for the current task.",
    promptSnippet: "Read agent registers",
    promptGuidelines: ["Use to recover goal/state/hypothesis/next action without scanning chat history."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      return { content: [{ type: "text", text: renderRegisters(state.registers) || "Agent registers are empty." }], details: { registers: state.registers } };
    },
  });

  pi.registerTool({
    name: "update_agent_registers",
    label: "Update Agent Registers",
    description: "Update small hot cognitive registers injected into turn context.",
    promptSnippet: "Update agent registers",
    promptGuidelines: ["Keep values short; store durable facts in context regions or project plans instead."],
    parameters: Type.Object({
      goal: Type.Optional(Type.String()),
      state: Type.Optional(Type.String()),
      hypothesis: Type.Optional(Type.String()),
      next_action: Type.Optional(Type.String()),
      risks: Type.Optional(Type.Array(Type.String())),
      done_when: Type.Optional(Type.Array(Type.String())),
      blocked_on: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      state.registers = {
        ...state.registers,
        goal: params.goal ?? state.registers.goal,
        state: params.state ?? state.registers.state,
        hypothesis: params.hypothesis ?? state.registers.hypothesis,
        nextAction: params.next_action ?? state.registers.nextAction,
        risks: params.risks ?? state.registers.risks,
        doneWhen: params.done_when ?? state.registers.doneWhen,
        blockedOn: params.blocked_on ?? state.registers.blockedOn,
      };
      await saveState(ctx.cwd, state);
      return { content: [{ type: "text", text: "Updated agent registers." }], details: { registers: state.registers } };
    },
  });

  pi.registerTool({
    name: "clear_agent_registers",
    label: "Clear Agent Registers",
    description: "Clear compact cognitive registers for the current task.",
    promptSnippet: "Clear agent registers",
    promptGuidelines: ["Use when the task changes or the hot state is stale."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      state.registers = {};
      await saveState(ctx.cwd, state);
      return { content: [{ type: "text", text: "Cleared agent registers." }], details: { registers: state.registers } };
    },
  });

  pi.registerTool({
    name: "ctx_region_write",
    label: "Write Context Region",
    description: "Create or update an addressable context-memory region.",
    promptSnippet: "Write context region",
    promptGuidelines: ["Use for durable task facts, failure traces, decisions, and scratch state that should survive context churn."],
    parameters: Type.Object({
      id: Type.String(),
      kind: stringEnum(["task", "code", "failure", "policy", "decision", "scratch", "checks", "diff"] as const),
      content: Type.String(),
      priority: Type.Optional(Type.Number()),
      ttl_turns: Type.Optional(Type.Number()),
      pinned: Type.Optional(Type.Boolean()),
      source_refs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!/^[a-zA-Z0-9_.:-]+$/.test(params.id)) throw new Error("Region id may only contain letters, numbers, _, ., :, and -");
      const state = await loadState(ctx.cwd);
      const existing = state.regions.find(region => region.id === params.id);
      const now = new Date().toISOString();
      const region: ContextRegion = {
        id: params.id,
        kind: params.kind as RegionKind,
        content: params.content,
        priority: Math.min(Math.max(0, params.priority ?? existing?.priority ?? 50), 100),
        ttlTurns: params.ttl_turns ?? existing?.ttlTurns,
        version: (existing?.version ?? 0) + 1,
        checksum: checksum(params.content),
        pinned: params.pinned ?? existing?.pinned,
        sourceRefs: params.source_refs ?? existing?.sourceRefs,
        lastUsedAt: Date.now(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.regions = [region, ...state.regions.filter(item => item.id !== params.id)];
      await saveState(ctx.cwd, state);
      return { content: [{ type: "text", text: `Wrote ctx://${region.id} v${region.version}` }], details: { region } };
    },
  });

  pi.registerTool({
    name: "ctx_region_read",
    label: "Read Context Region",
    description: "Read one addressable context-memory region by id.",
    promptSnippet: "Read context region",
    promptGuidelines: ["Use ctx_region_list first if you do not know the region id."],
    parameters: Type.Object({ id: Type.String(), max_chars: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      const region = state.regions.find(item => item.id === params.id);
      if (!region) throw new Error(`Unknown context region: ${params.id}`);
      region.lastUsedAt = Date.now();
      await saveState(ctx.cwd, state);
      const maxChars = Math.min(Math.max(100, params.max_chars ?? 4000), 20000);
      return { content: [{ type: "text", text: renderRegion(region, maxChars) }], details: { region } };
    },
  });

  pi.registerTool({
    name: "ctx_region_list",
    label: "List Context Regions",
    description: "List addressable context-memory regions without dumping full content.",
    promptSnippet: "List context regions",
    promptGuidelines: ["Use to discover ctx:// region ids before reading details."],
    parameters: Type.Object({ kind: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      const regions = sortRegions(state.regions)
        .filter(region => !params.kind || region.kind === params.kind)
        .slice(0, Math.min(Math.max(1, params.limit ?? 20), 100));
      const text = regions.length ? regions.map(region => `ctx://${region.id} kind=${region.kind} v${region.version} priority=${region.priority}${region.pinned ? " pinned" : ""} ${region.checksum}`).join("\n") : "No context regions.";
      return { content: [{ type: "text", text }], details: { regions } };
    },
  });

  pi.registerTool({
    name: "ctx_region_pin",
    label: "Pin Context Region",
    description: "Pin or unpin a context-memory region for preferential injection.",
    promptSnippet: "Pin context region",
    promptGuidelines: ["Pin only high-signal active task regions to avoid context bloat."],
    parameters: Type.Object({ id: Type.String(), pinned: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      const region = state.regions.find(item => item.id === params.id);
      if (!region) throw new Error(`Unknown context region: ${params.id}`);
      region.pinned = params.pinned ?? true;
      region.updatedAt = new Date().toISOString();
      await saveState(ctx.cwd, state);
      return { content: [{ type: "text", text: `${region.pinned ? "Pinned" : "Unpinned"} ctx://${region.id}` }], details: { region } };
    },
  });

  pi.registerTool({
    name: "ctx_region_evict",
    label: "Evict Context Region",
    description: "Remove a stale addressable context-memory region.",
    promptSnippet: "Evict context region",
    promptGuidelines: ["Use when a task changes or a region is stale/low-signal."],
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      const before = state.regions.length;
      state.regions = state.regions.filter(region => region.id !== params.id);
      await saveState(ctx.cwd, state);
      return { content: [{ type: "text", text: before === state.regions.length ? `No region evicted for ${params.id}` : `Evicted ctx://${params.id}` }], details: { id: params.id, evicted: before !== state.regions.length } };
    },
  });

  pi.registerTool({
    name: "compile_tool_grammar",
    label: "Compile Tool Grammar",
    description: "Compile a task-local tool grammar plus a budget plan.",
    promptSnippet: "Compile task tool grammar",
    promptGuidelines: ["Use to constrain a task to a small allowed tool sequence before risky or multi-step work."],
    parameters: Type.Object({
      intent: Type.String(),
      risk_level: Type.Optional(stringEnum(["low", "medium", "high"] as const)),
      max_context_chars: Type.Optional(Type.Number()),
      max_tool_calls: Type.Optional(Type.Number()),
      max_check_runs: Type.Optional(Type.Number()),
      max_branch_count: Type.Optional(Type.Number()),
      reasoning_budget: Type.Optional(stringEnum(["low", "medium", "high", "max"] as const)),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const riskLevel = (params.risk_level ?? "medium") as RiskLevel;
      const state = await loadState(ctx.cwd);
      state.grammar = grammarFor(params.intent, riskLevel);
      state.budget = budgetFor(riskLevel, {
        maxContextChars: params.max_context_chars,
        maxToolCalls: params.max_tool_calls,
        maxCheckRuns: params.max_check_runs,
        maxBranchCount: params.max_branch_count,
        reasoningBudget: params.reasoning_budget,
      } as Partial<AgentBudget>);
      await saveState(ctx.cwd, state);
      return { content: [{ type: "text", text: `${renderGrammar(state.grammar)}\n${renderBudget(state.budget)}` }], details: { grammar: state.grammar, budget: state.budget } };
    },
  });

  pi.registerTool({
    name: "current_tool_grammar",
    label: "Current Tool Grammar",
    description: "Inspect the current task-local tool grammar.",
    promptSnippet: "Inspect current tool grammar",
    promptGuidelines: ["Use before choosing tools when a task grammar may be active."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      if (!state.grammar) return { content: [{ type: "text", text: "No active tool grammar." }], details: { grammar: null } };
      return { content: [{ type: "text", text: renderGrammar(state.grammar) }], details: { grammar: state.grammar } };
    },
  });

  pi.registerTool({
    name: "current_agent_budget",
    label: "Current Agent Budget",
    description: "Inspect the current context/tool/check/branch budget plan.",
    promptSnippet: "Inspect agent budget",
    promptGuidelines: ["Use to avoid tokenmaxxing and keep branch/search/check behavior bounded."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      return { content: [{ type: "text", text: renderBudget(state.budget) }], details: { budget: state.budget } };
    },
  });
}
