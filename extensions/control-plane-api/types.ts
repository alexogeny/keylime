export type ApiEnvelope<T> = { ok: true; data: T; meta: ApiMeta } | { ok: false; error: ApiError; meta: ApiMeta };
export type ApiMeta = { requestId: string; generatedAt: number; backend: "pi" | "compatible"; capabilities?: string[] };
export type ApiError = { code: string; message: string; detail?: unknown };

export type AgentState = "idle" | "thinking" | "planning" | "using_memory" | "reading_files" | "writing_files" | "researching" | "calling_tools" | "waiting_approval" | "retrying" | "patching" | "testing" | "summarizing" | "done" | "error";
export type ModelSummary = { id: string; provider?: string; name?: string; contextWindow?: number; input?: string[]; reasoning?: boolean; privacy?: "local" | "remote" | "unknown" };
export type TokenUsage = { input?: number; output?: number; total?: number; cacheRead?: number; cacheWrite?: number };
export type CostUsage = { input?: number; output?: number; total?: number; currency?: string };
export type MeterStatus = { state: "idle" | "active" | "warning" | "error"; detail?: string; count?: number };

export type ControlPlaneState = {
  cwd: string;
  token?: string;
  dataDir?: string;
  sendUserMessage?: (text: string, options?: any) => void | Promise<void>;
  getEntries?: () => any[];
  getCommands?: () => any[];
  runtime?: RuntimeState;
  memoryFile?: string;
};

export type RuntimeState = {
  agentState: AgentState;
  model?: ModelSummary;
  previousModel?: ModelSummary;
  thinkingLevel?: unknown;
  source?: string;
  updatedAt?: number;
};

export type SystemCapabilityMap = Record<"chat" | "streaming" | "memory" | "structuredMemory" | "research" | "files" | "patches" | "modelSwitching" | "approvals" | "toolInspection" | "costTracking" | "runTracing" | "knowledgeGraph", boolean>;

export type ChatMessage = { id: string; role: "user" | "assistant" | "system" | "tool" | "event"; content: string; createdAt?: number; runId?: string; model?: ModelSummary; refs?: Record<string, string[]> };
export type ChatThreadSummary = { id: string; title: string; updatedAt?: number; messageCount: number; topics?: string[] };
export type ToolCall = { id: string; name: string; namespace?: string; status: "pending" | "running" | "success" | "error" | "blocked" | "cancelled"; startedAt?: number; endedAt?: number; durationMs?: number; inputPreview?: string; outputPreview?: string; tokenUsage?: TokenUsage; cost?: CostUsage; error?: ApiError; raw?: unknown };
export type RunSummary = { id: string; threadId?: string; prompt?: string; state: AgentState; model?: ModelSummary; startedAt?: number; endedAt?: number; durationMs?: number; tokenUsage?: TokenUsage; cost?: CostUsage };
export type RunStep = { id: string; type: string; title: string; timestamp?: number; status?: string; detail?: unknown };

export type ResearchEntrySummary = { id: string; title: string; summary?: string; tags: string[]; categories: string[]; sourceCount: number; confidence?: number; createdAt?: number; updatedAt?: number };
export type ResearchEntryDetail = ResearchEntrySummary & { keyFacts: string[]; citations: any[]; sources: any[]; backlinks: any[]; relatedTopics: ResearchEntrySummary[]; origin?: Record<string, string>; raw?: unknown };

export type MemoryItem = { id: string; content: string; category?: string; subcategory?: string; tags: string[]; confidence?: number; freshness?: number; privacy?: { sensitivity?: string; excluded?: boolean; scopedTo?: string[] }; usage?: { mentions?: number; lastUsedAt?: number }; source?: any; raw?: unknown };
export type TimelineEvent = { id: string; label: string; subkind?: string; interval?: any; data?: Record<string, unknown>; notes?: string; memory?: MemoryItem };
export type EntitySummary = { id: string; label: string; type: string; description?: string; confidence?: number; connectedCount?: number };

export type GraphNodeSummary = { id: string; label: string; type: "person" | "project" | "company" | "file" | "research_topic" | "memory" | "task" | "conversation" | "tool" | "model" | "workspace"; weight?: number };
export type GraphEdgeSummary = { id: string; from: string; to: string; type: string; weight?: number };

export type FileRef = { path: string; kind?: "file" | "directory"; modified?: boolean; generated?: boolean; attached?: boolean; summary?: string };
export type WorkspaceSummary = { id: string; name: string; path: string; active?: boolean };
export type PatchSummary = { id: string; title: string; status: "pending" | "approved" | "rejected" | "applied" | "rolled_back"; files: string[]; createdAt?: number };
export type ApprovalRequest = { id: string; kind: "tool_call" | "file_write" | "patch_apply" | "command" | "network" | "memory_write" | "model_switch"; title: string; status: "pending" | "approved" | "rejected"; createdAt?: number; detail?: unknown };
export type ScreenCommand = { id: string; label: string; description?: string; shortcut?: string; disabled?: boolean };
