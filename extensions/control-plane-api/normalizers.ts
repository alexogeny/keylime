import type { AgentState, ChatMessage, GraphEdgeSummary, GraphNodeSummary, MemoryItem, ModelSummary, ResearchEntryDetail, ResearchEntrySummary, TimelineEvent, ToolCall } from "./types";

export const CAPABILITIES = ["chat", "memory", "structuredMemory", "research", "files", "toolInspection", "runTracing", "knowledgeGraph"];

export function normalizeModel(model: any): ModelSummary | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return { id: model, privacy: "unknown" };
  return { id: String(model.id ?? model.model ?? model.name ?? "unknown"), provider: model.provider, name: model.name, contextWindow: model.contextWindow, input: model.input, reasoning: model.reasoning, privacy: model.local ? "local" : model.privacy ?? "unknown" };
}

export function entryText(e: any): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  const c = e.content ?? e.text ?? e.message?.content ?? e.data?.content ?? "";
  if (Array.isArray(c)) return c.map(x => x.text || x.content || "").join("\n");
  return typeof c === "object" ? JSON.stringify(c, null, 2) : String(c);
}

export function entryRole(e: any): ChatMessage["role"] {
  const role = String(e?.role ?? e?.message?.role ?? e?.type ?? e?.customType ?? "event");
  return ["user", "assistant", "system", "tool"].includes(role) ? role as ChatMessage["role"] : "event";
}

export function normalizeMessages(entries: any[] = []): ChatMessage[] {
  return entries.map((e, i) => ({ id: String(e.id ?? e.entryId ?? `entry-${i}`), role: entryRole(e), content: entryText(e), createdAt: e.created_at ?? e.timestamp, model: normalizeModel(e.model) })).filter(m => m.content);
}

export function normalizeToolCall(raw: any, i = 0): ToolCall {
  const status = raw.error ? "error" : raw.status === "blocked" ? "blocked" : raw.status ?? "success";
  return { id: String(raw.id ?? raw.result_id ?? raw.toolCallId ?? `tool-${i}`), name: String(raw.toolName ?? raw.tool ?? raw.name ?? "tool"), status, startedAt: raw.startedAt ?? raw.createdAt, endedAt: raw.endedAt, durationMs: raw.durationMs, inputPreview: preview(raw.input ?? raw.args ?? raw.parameters), outputPreview: preview(raw.output ?? raw.result ?? raw.summary), raw } as ToolCall;
}

export function normalizeResearchSummary(e: any): ResearchEntrySummary {
  return { id: String(e.id), title: e.query ?? e.title ?? e.id, summary: e.distilled?.summary ?? e.summary, tags: e.distilled?.tags ?? e.tags ?? [], categories: e.distilled?.categories ?? e.categories ?? [], sourceCount: e.raw?.results?.length ?? e.sources?.length ?? 0, confidence: e.distilled?.confidence, createdAt: e.timestamp, updatedAt: e.updatedAt ?? e.timestamp };
}

export function normalizeResearchDetail(e: any, related: ResearchEntrySummary[] = []): ResearchEntryDetail {
  const s = normalizeResearchSummary(e);
  return { ...s, keyFacts: e.distilled?.key_facts ?? e.distilled?.keyFacts ?? [], citations: e.distilled?.citations ?? [], sources: e.distilled?.sources ?? e.raw?.results ?? [], backlinks: [], relatedTopics: related, origin: e.origin, raw: e };
}

export function normalizeMemory(m: any): MemoryItem {
  return { id: String(m.id), content: String(m.content ?? m.timeline?.label ?? ""), category: m.category, subcategory: m.subcategory, tags: m.tags ?? [], confidence: m.confidence, freshness: m.updated_at, privacy: { sensitivity: m.sensitivity, excluded: Boolean(m.excluded) }, usage: { mentions: m.mentions, lastUsedAt: m.last_used_at }, source: { sourceSession: m.source_session, sourceMemories: m.source_memories }, raw: m };
}

export function normalizeTimeline(m: any): TimelineEvent {
  const t = m.timeline ?? {};
  return { id: String(m.id), label: t.label ?? m.content ?? t.subkind ?? "event", subkind: t.subkind, interval: t.interval, data: t.data ?? {}, notes: t.notes, memory: normalizeMemory(m) };
}

export function splitMemory(store: any) {
  const timeline: TimelineEvent[] = [], pinned: MemoryItem[] = [], memories: MemoryItem[] = [];
  for (const m of store.memories ?? []) {
    if (m.timeline?.kind === "profile.timeline") timeline.push(normalizeTimeline(m));
    else if ((m.tags ?? []).some((t: string) => ["name", "height", "weight", "measurements", "body", "dob", "birthday", "age", "profile"].includes(String(t).toLowerCase()))) pinned.push(normalizeMemory(m));
    else memories.push(normalizeMemory(m));
  }
  return { profile: store.profile ?? {}, timeline, pinned, memories };
}

export function buildGraph(memoryBundle: ReturnType<typeof splitMemory>, research: ResearchEntrySummary[], cwd: string) {
  const nodes: GraphNodeSummary[] = [{ id: `workspace:${cwd}`, label: cwd.split("/").pop() || cwd, type: "workspace", weight: 1 }];
  const edges: GraphEdgeSummary[] = [];
  for (const m of [...memoryBundle.pinned, ...memoryBundle.memories]) {
    nodes.push({ id: `memory:${m.id}`, label: m.content.slice(0, 80), type: "memory", weight: m.confidence });
    edges.push({ id: `edge:workspace-memory:${m.id}`, from: `workspace:${cwd}`, to: `memory:${m.id}`, type: "contains" });
  }
  for (const t of memoryBundle.timeline) nodes.push({ id: `timeline:${t.id}`, label: t.label, type: "memory", weight: t.memory?.confidence });
  for (const r of research) nodes.push({ id: `research:${r.id}`, label: r.title, type: "research_topic", weight: r.confidence });
  return { nodes, edges, clusters: [] };
}

export function preview(value: unknown, max = 600) {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export function inferAgentState(runtime: any): AgentState { return runtime?.agentState ?? "idle"; }
