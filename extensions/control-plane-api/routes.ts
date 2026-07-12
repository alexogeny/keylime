import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { isPathWithin } from "../shared/path-policy";
import { ok, fail, parseJson } from "./envelope";
import { CAPABILITIES, buildGraph, inferAgentState, normalizeMessages, normalizeModel, normalizeResearchDetail, normalizeResearchSummary, normalizeToolCall, splitMemory } from "./normalizers";
import { DEFAULT_DATA_DIR, listWorkspaceFiles, readJson, readMemoryStore, readResearchEntry, readResearchIndex, readToolResult, readToolResultIndex, writeJson, writeMemoryStore } from "./stores";
import type { ControlPlaneState, ScreenCommand, SystemCapabilityMap } from "./types";

const systemCaps: SystemCapabilityMap = { chat: true, streaming: false, memory: true, structuredMemory: true, research: true, files: true, patches: false, modelSwitching: false, approvals: false, toolInspection: true, costTracking: false, runTracing: true, knowledgeGraph: true };

export async function handleControlPlaneRequest(request: Request, state: ControlPlaneState): Promise<Response> {
  const url = new URL(request.url);
  if (state.token && request.headers.get("authorization") !== `Bearer ${state.token}`) return fail("UNAUTHORIZED", "Bearer token required", 401);
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === "/api/system" && request.method === "GET") return ok({ backend: "pi", version: 1, cwd: state.cwd, authenticated: Boolean(state.token), capabilities: ["chat", "memory", "research", "files", "patches", "models", "approvals", "tools", "graph", "runs", "modelSwitch"], capabilityMap: systemCaps }, CAPABILITIES);
    if (url.pathname === "/api/status" && request.method === "GET") return ok(await statusBundle(state), CAPABILITIES);
    if (url.pathname === "/api/events" && request.method === "GET") return eventStream(url.searchParams.get("since") ?? undefined);

    if (url.pathname === "/api/chat/threads" && request.method === "GET") return ok(await chatThreads(state, url.searchParams.get("q") ?? ""), CAPABILITIES);
    const chatThread = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)$/);
    if (chatThread && request.method === "GET") return ok(await chatThreadBundle(state, decodeURIComponent(chatThread[1]!)), CAPABILITIES);
    const chatMessage = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)\/messages$/);
    if (chatMessage && request.method === "POST") return ok(await sendChatMessage(state, await parseJson(request), decodeURIComponent(chatMessage[1]!)), CAPABILITIES, 202);
    const chatInterrupt = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)\/interrupt$/);
    if (chatInterrupt && request.method === "POST") return ok(await runControl(state, decodeURIComponent(chatInterrupt[1]!), "cancel", await parseJson(request).catch(() => ({}))), CAPABILITIES);

    if (url.pathname === "/api/runs" && request.method === "GET") return ok(await runsBundle(state), CAPABILITIES);
    const run = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (run && request.method === "GET") return ok(await runDetail(state, decodeURIComponent(run[1]!)), CAPABILITIES);

    if (url.pathname === "/api/search" && request.method === "GET") return ok(await searchBundle(state, url.searchParams.get("q") ?? ""), CAPABILITIES);
    if (url.pathname === "/api/research" && request.method === "GET") return ok(await researchBundle(url.searchParams.get("q") ?? "", url.searchParams.get("tag") ?? "", state), CAPABILITIES);
    const research = url.pathname.match(/^\/api\/research\/([^/]+)$/);
    if (research && request.method === "GET") return ok(await researchDetail(decodeURIComponent(research[1]!)), CAPABILITIES);

    if (url.pathname === "/api/memory" && request.method === "GET") return ok(await memoryBundle(), CAPABILITIES);
    if (url.pathname === "/api/memory/items" && request.method === "GET") { const m = await memoryBundle(state); const q = (url.searchParams.get("q") ?? "").toLowerCase(); const items = [...m.pinned, ...m.memories].filter((x: any) => !q || JSON.stringify(x).toLowerCase().includes(q)); return ok({ items, nextCursor: undefined }, CAPABILITIES); }

    if (url.pathname === "/api/graph" && request.method === "GET") return ok(await graphBundle(state), CAPABILITIES);
    const graphNode = url.pathname.match(/^\/api\/graph\/nodes\/(.+)$/);
    if (graphNode && request.method === "GET") return ok(await graphNodeBundle(state, decodeURIComponent(graphNode[1]!)), CAPABILITIES);

    if (url.pathname === "/api/workspaces" && request.method === "GET") { const saved = await controlRead(state, "workspaces", [] as any[]); const base = { id: state.cwd, name: state.cwd.split("/").pop() || state.cwd, path: state.cwd, active: !saved.some((w: any) => w.active) }; return ok({ active: saved.find((w: any) => w.active)?.id ?? state.cwd, workspaces: [base, ...saved] }, CAPABILITIES); }
    if (url.pathname === "/api/workspace" && request.method === "GET") return ok(await workspaceBundle(state), CAPABILITIES);
    if (url.pathname === "/api/workspace/files" && request.method === "GET") { const tree = (await listWorkspaceFiles(state.cwd)).map((f, i) => ({ id: f.path, name: f.path.split("/").pop(), depth: f.path.split("/").length - 1, type: f.kind, status: "" })); return ok({ root: state.cwd, tree, items: tree, nextCursor: undefined }, CAPABILITIES); }
    const workspaceFile = url.pathname.match(/^\/api\/workspace\/files\/(.+)$/);
    if (workspaceFile && request.method === "GET") return ok(await workspaceFileDetail(state, decodeURIComponent(workspaceFile[1]!)), CAPABILITIES);

    if (url.pathname === "/api/tools" && request.method === "GET") return ok(await toolsCatalog(state), CAPABILITIES);
    if (url.pathname === "/api/tool-calls" && request.method === "GET") { const calls = (await readToolResultIndex(state.cwd)).map(normalizeToolCall); return ok({ items: calls, calls, nextCursor: undefined }, CAPABILITIES); }
    const toolCall = url.pathname.match(/^\/api\/tool-calls\/([^/]+)$/);
    if (toolCall && request.method === "GET") { const raw = await readToolResult(state.cwd, decodeURIComponent(toolCall[1]!)); return ok({ call: normalizeToolCall(raw), input: raw.input ?? raw.args ?? raw.parameters, output: raw.output ?? raw.result, raw }, CAPABILITIES); }

    if (url.pathname === "/api/models" && request.method === "GET") return ok(await modelsBundle(state), CAPABILITIES);
    if (url.pathname === "/api/models/select" && request.method === "POST") return ok(await selectModel(state, await parseJson(request)), CAPABILITIES);
    if (url.pathname === "/api/approvals" && request.method === "GET") { const approvals = await controlRead(state, "approvals", [] as any[]); const status = url.searchParams.get("status"); const items = approvals.filter((a: any) => !status || (status === "history" ? a.status !== "pending" : a.status === status)); return ok({ items, pending: approvals.filter((a: any) => a.status === "pending"), history: approvals.filter((a: any) => a.status !== "pending"), nextCursor: undefined }, CAPABILITIES); }
    if (url.pathname === "/api/patches" && request.method === "GET") { const patches = await controlRead(state, "patches", [] as any[]); const status = url.searchParams.get("status"); const items = patches.filter((p: any) => !status || p.status === status); return ok({ items, patches: items, nextCursor: undefined }, CAPABILITIES); }
    const patchDetail = url.pathname.match(/^\/api\/patches\/([^/]+)$/);
    if (patchDetail && request.method === "GET") return ok(await patchDetailBundle(state, decodeURIComponent(patchDetail[1]!)), CAPABILITIES);
    if (url.pathname === "/api/settings" && request.method === "GET") return ok(await settingsBundle(state), CAPABILITIES);
    if (url.pathname === "/api/providers" && request.method === "GET") { const providers = await controlRead(state, "providers", [] as any[]); return ok({ items: providers, providers, nextCursor: undefined }, CAPABILITIES); }
    if (url.pathname === "/api/attachments" && request.method === "GET") { const attachments = await controlRead(state, "attachments", [] as any[]); return ok({ items: attachments.map((a: any) => ({ ...a, content: undefined })), attachments: attachments.map((a: any) => ({ ...a, content: undefined })), nextCursor: undefined }, CAPABILITIES); }
    const attachmentGet = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
    if (attachmentGet && request.method === "GET") { const attachments = await controlRead(state, "attachments", [] as any[]); const a = attachments.find((x: any) => x.id === decodeURIComponent(attachmentGet[1]!)); return a ? ok({ ...a, url: `/api/attachments/${a.id}`, content: undefined }, CAPABILITIES) : fail("NOT_FOUND", "Attachment not found", 404); }

    const mutation = await handleMutationRoute(request, url, state);
    if (mutation) return mutation;

    const screen = url.pathname.match(/^\/api\/screens\/([^/]+)(?:\/(.+))?$/);
    if (screen && request.method === "GET") return ok(await screenBundle(state, screen[1]!, screen[2] ? decodeURIComponent(screen[2]) : undefined), CAPABILITIES);

    return fail("NOT_FOUND", "No control-plane route matched", 404);
  } catch (error: any) {
    return fail("INTERNAL_ERROR", error?.message ?? String(error), 500, error?.stack);
  }
}

async function statusBundle(state: ControlPlaneState) {
  const runtime = state.runtime ?? { agentState: "idle" };
  const memory = await memoryBundle(state).catch(() => ({ stats: { total: 0 } } as any));
  const research = await researchBundle().catch(() => ({ items: [] } as any));
  const tools = await readToolResultIndex(state.cwd).catch(() => [] as any[]);
  const approvals = await controlRead(state, "approvals", [] as any[]);
  const model = normalizeModel(runtime.model);
  return { workspace: { name: state.cwd.split("/").pop() || state.cwd, path: state.cwd }, model, provider: { name: model?.provider ?? "unknown", status: model ? "connected" : "unknown" }, agentState: inferAgentState(runtime), agent: { state: inferAgentState(runtime), currentTask: undefined }, tokens: { used: 0, max: model?.contextWindow ?? 0 }, cost: { today: "$0.00", cap: undefined }, counts: { memory: memory.stats?.total ?? 0, research: research.items?.length ?? 0, tools: tools.length, approvalsPending: approvals.filter((a: any) => a.status === "pending").length }, meters: { tokens: {}, cost: {}, memory: { state: "active", count: memory.stats?.total ?? 0 }, research: { state: "active", count: research.items?.length ?? 0 }, tools: { state: "active", count: tools.length }, approvalsPending: approvals.filter((a: any) => a.status === "pending").length } };
}

async function chatThreads(state: ControlPlaneState, query = "") {
  const messages = normalizeMessages(state.getEntries?.() ?? []);
  const saved = await controlRead(state, "chat-threads", { threads: [] as any[] });
  const current = { id: "current", title: "Current session", preview: messages.at(-1)?.content ?? "", state: inferAgentState(state.runtime), time: new Date().toISOString(), updatedAt: Date.now(), messageCount: messages.length, counts: { messages: messages.length }, topics: [] };
  const items = [current, ...saved.threads].filter((t: any) => !t.deleted && (!query || JSON.stringify(t).toLowerCase().includes(query.toLowerCase())));
  return { items, threads: items, nextCursor: undefined };
}

async function chatThreadBundle(state: ControlPlaneState, id: string) {
  const messages = normalizeMessages(state.getEntries?.() ?? []);
  return { thread: { id, title: id === "current" ? "Current session" : id, updatedAt: Date.now(), messageCount: messages.length, topics: [] }, messages, runs: [], pinned: [], bookmarks: [] };
}

async function sendChatMessage(state: ControlPlaneState, body: any, threadId = "current") {
  const content = String(body.content ?? body.message ?? "").trim();
  if (!content) throw new Error("message content required");
  await state.sendUserMessage?.(content, { deliverAs: body.mode ?? "followUp" });
  const message = { id: crypto.randomUUID(), threadId, role: "user", content, attachments: body.attachments ?? [], createdAt: new Date().toISOString() };
  const actions = await controlRead(state, "message-actions", [] as any[]); actions.push(message); await controlWrite(state, "message-actions", actions);
  return { queued: Boolean(state.sendUserMessage), message };
}

async function runsBundle(state: ControlPlaneState) {
  const messages = normalizeMessages(state.getEntries?.() ?? []);
  const items = messages.map((m, i) => ({ id: `run-${i}`, threadId: "current", prompt: m.role === "user" ? m.content : undefined, status: "done", state: "done", time: m.createdAt ? new Date(m.createdAt).toISOString() : new Date().toISOString(), duration: undefined, cost: "$0.00", tools: 0, startedAt: m.createdAt, model: m.model }));
  return { items, runs: items, nextCursor: undefined };
}

async function runDetail(state: ControlPlaneState, id: string) {
  return { run: { id, threadId: "current", state: inferAgentState(state.runtime), model: normalizeModel(state.runtime?.model) }, context: { instructions: [], memories: [], research: [], files: [], workspaceContext: [state.cwd] }, steps: [], toolCalls: (await readToolResultIndex(state.cwd)).map(normalizeToolCall), filesRead: [], filesWritten: [], patches: [], approvals: [], errors: [] };
}

async function researchBundle(q = "", tag = "", state?: ControlPlaneState) {
  const entries = (await readResearchIndex(q)).map(normalizeResearchSummary).filter((e: any) => !tag || e.tags.includes(tag));
  const overlays = state ? await controlRead(state, "research-overrides", [] as any[]).catch(() => []) : [];
  const hidden = new Set(overlays.filter((o: any) => o.deleted).map((o: any) => o.id));
  const items = entries.filter(e => !hidden.has(e.id)).map((e: any) => ({ ...e, sources: e.sourceCount, claims: [], recency: e.updatedAt ? new Date(e.updatedAt).toISOString() : undefined, backlinks: [] }));
  const facet = (name: "tags" | "categories") => Object.entries(entries.flatMap((e: any) => e[name] ?? []).reduce((a: any, x: string) => (a[x] = (a[x] ?? 0) + 1, a), {})).map(([value, count]) => ({ value, count }));
  return { items, entries: items, facets: { tags: facet("tags"), sources: [], topics: facet("categories") }, nextCursor: undefined };
}

async function researchDetail(id: string) {
  const entry = await readResearchEntry(id);
  if (!entry) throw new Error("research entry not found");
  const related = (await readResearchIndex("")) .filter((e: any) => e.id !== id).slice(0, 8).map(normalizeResearchSummary);
  return normalizeResearchDetail(entry, related);
}

async function memoryBundle(state?: ControlPlaneState) {
  const store = state ? await readCpMemoryStore(state) : await readMemoryStore();
  const split = splitMemory(store);
  return { profile: Object.entries(split.profile ?? {}).flatMap(([section, fields]: any) => Object.entries(fields ?? {}).map(([k, v]: any) => ({ k: `${section}.${k}`, v, confidence: undefined, source: undefined, privacy: undefined }))), profileRaw: split.profile, timeline: split.timeline.map(t => ({ ...t, t: t.interval?.start?.value, text: t.label, tag: t.subkind })), pinned: split.pinned, memories: split.memories, timelines: [{ id: "profile", label: "Profile timeline", events: split.timeline }], entities: [], relationships: [], preferences: split.memories.filter(m => m.category === "preference").map((m: any) => ({ ...m, k: m.subcategory ?? m.tags?.[0] ?? m.id, v: m.content, freq: m.usage?.mentions ?? 0 })), projects: [], recent: [...split.pinned, ...split.memories].slice(0, 20), sensitive: [...split.pinned, ...split.memories].filter(m => m.privacy?.sensitivity && m.privacy.sensitivity !== "baseline"), stats: { total: (store.memories ?? []).length, timeline: split.timeline.length, pinned: split.pinned.length } };
}

async function graphBundle(state: ControlPlaneState) {
  const memory = splitMemory(await readCpMemoryStore(state));
  const research = (await readResearchIndex("")).slice(0, 100).map(normalizeResearchSummary);
  const graph = buildGraph(memory, research, state.cwd); const overrides = await controlRead(state, "graph-overrides", { nodes: [], edges: [] } as any); return { nodes: [...graph.nodes, ...overrides.nodes.filter((n: any) => !n.deleted)].map((n: any) => ({ ...n, name: n.name ?? n.label, conns: graph.edges.filter((e: any) => e.from === n.id || e.to === n.id).length })), edges: [...graph.edges, ...overrides.edges.filter((e: any) => !e.deleted)], clusters: graph.clusters };
}

async function graphNodeBundle(state: ControlPlaneState, id: string) {
  const graph = await graphBundle(state);
  const mem = await memoryBundle(state); return { node: graph.nodes.find(n => n.id === id) ?? { id, label: id, name: id, type: "workspace" }, adjacent: graph.nodes.filter(n => n.id !== id).slice(0, 30), edges: graph.edges.filter(e => e.from === id || e.to === id), memories: mem.recent, research: (await researchBundle()).items.slice(0, 12), chats: (await chatThreads(state)).items, files: [], people: graph.nodes.filter((n: any) => n.type === "person"), timeline: mem.timeline, toolActivity: (await readToolResultIndex(state.cwd)).slice(0, 20).map(normalizeToolCall) };
}

async function workspaceBundle(state: ControlPlaneState) {
  const files = await listWorkspaceFiles(state.cwd, 80);
  const activeContext = await controlRead(state, "workspace-context", [] as any[]);
  const changes = await controlRead(state, "workspace-changes", [] as any[]);
  const attached = await controlRead(state, "attachments", [] as any[]);
  return { workspace: { id: state.cwd, name: state.cwd.split("/").pop() || state.cwd, path: state.cwd, active: true }, instructions: [], activeContext, recent: files.filter(f => f.kind === "file").slice(0, 20), recentFiles: files.filter(f => f.kind === "file").slice(0, 20), modified: changes.filter((c: any) => c.action !== "discard"), modifiedFiles: changes.filter((c: any) => c.action !== "discard"), generated: [], generatedFiles: [], attached: attached.map((a: any) => ({ ...a, content: undefined })), attachedFiles: attached.map((a: any) => ({ ...a, content: undefined })), projectMemory: (await memoryBundle(state)).projects };
}

async function workspaceFileDetail(state: ControlPlaneState, id: string) {
  const target = normalize(join(state.cwd, id));
  if (!isPathWithin(state.cwd, target)) throw new Error("unsafe workspace file path");
  const content = await readFile(target, "utf8").catch(() => "");
  const changes = await controlRead(state, "workspace-changes", [] as any[]);
  return { id, name: id.split("/").pop() ?? id, summary: content ? content.slice(0, 400) : undefined, content, diff: changes.filter((c: any) => c.file === id), added: 0, removed: 0, writtenBy: undefined, createdAt: undefined };
}

async function patchDetailBundle(state: ControlPlaneState, id: string) {
  const patches = await controlRead(state, "patches", [] as any[]);
  const patch = patches.find((p: any) => p.id === id) ?? { id, title: id, files: [], status: "review" };
  return { ...patch, files: (patch.files ?? []).map((f: any) => typeof f === "string" ? { name: f, added: 0, removed: 0, status: patch.status } : f), diff: patch.diff ?? [], explanation: patch.explanation, checks: patch.checks ?? { tests: [], lint: [] } };
}

async function toolsCatalog(state: ControlPlaneState) {
  const perms = await controlRead(state, "tool-permissions", {} as any);
  const calls = (await readToolResultIndex(state.cwd)).map(normalizeToolCall);
  const names = [...new Set([...Object.keys(perms), ...calls.map(c => c.name)])];
  const items = names.map(name => ({ name, mode: perms[name]?.mode ?? "ask", calls: calls.filter(c => c.name === name).length, desc: perms[name]?.description ?? "" }));
  return { items, tools: items, nextCursor: undefined };
}

async function searchBundle(state: ControlPlaneState, q: string) {
  const query = q.toLowerCase();
  const threads = (await chatThreads(state, q)).items;
  const research = (await researchBundle(q, "", state)).items;
  const memory = (await memoryBundle(state)).recent.filter((m: any) => !query || JSON.stringify(m).toLowerCase().includes(query));
  const files = (await listWorkspaceFiles(state.cwd, 200)).filter(f => !query || f.path.toLowerCase().includes(query));
  const graph = await graphBundle(state);
  return { threads, research, memory, files, entities: graph.nodes.filter((n: any) => !query || JSON.stringify(n).toLowerCase().includes(query)) };
}

async function modelsBundle(state: ControlPlaneState) {
  const saved = await controlRead(state, "models", { current: undefined as any, defaults: {} as Record<string, unknown>, fallbackChain: [] as any[] });
  const current = normalizeModel(state.runtime?.model) ?? saved.current;
  const rawModels = state.runtime?.model ? [normalizeModel(state.runtime.model)].filter(Boolean) : (saved.current ? [saved.current] : []);
  const items = rawModels.map((m: any) => ({ ...m, name: m.name ?? m.id, ctx: m.contextWindow, costIn: "$0.00", costOut: "$0.00", latency: undefined, vision: m.input?.includes("image") ?? false, tools: true, local: m.privacy === "local", status: "available", active: current?.id === m.id }));
  return { current, items, models: items, providers: [], fallbackChain: saved.fallbackChain ?? [], defaults: saved.defaults ?? {}, switchability: { supported: false, reason: "Pi model switching is interactive-only unless a backend adapter implements direct selection." } };
}

async function settingsBundle(state: ControlPlaneState) {
  const settings = await controlRead(state, "settings", {} as any);
  const legacyProfile = await readJson(join(state.dataDir ?? DEFAULT_DATA_DIR, "profile.json"), {});
  return { profile: settings.profile ?? legacyProfile, workspaces: [{ id: state.cwd, path: state.cwd }], instructions: settings.instructions ?? {}, tone: settings.tone ?? {}, privacy: settings.privacy ?? {}, memorySettings: settings.memory ?? {}, memory: settings.memory ?? {}, modelSettings: settings.models ?? {}, models: settings.models ?? {}, toolPermissions: Object.entries(await controlRead(state, "tool-permissions", {} as any)).map(([name, value]: any) => ({ name, ...value })), tools: settings.tools ?? {}, costLimits: settings.cost ?? {}, cost: settings.cost ?? {}, theme: settings.theme ?? {}, shortcuts: settings.shortcuts ?? [], agentDefaults: settings.agent ?? {}, agent: settings.agent ?? {} };
}

async function screenBundle(state: ControlPlaneState, name: string, id?: string) {
  const commands: ScreenCommand[] = [{ id: "palette", label: "Command palette", shortcut: "⌘K" }];
  if (name === "dashboard") { const status = await statusBundle(state); return { status, stats: [{ label: "Memory", value: status.counts.memory, sub: "items" }, { label: "Research", value: status.counts.research, sub: "entries" }], threads: (await chatThreads(state)).items, activity: (await runsBundle(state)).items, research: (await researchBundle()).items.slice(0, 6), approvalsPending: (await controlRead(state, "approvals", [] as any[])).filter((a: any) => a.status === "pending"), commands }; }
  if (name === "chat") return { ...(await chatThreadBundle(state, id ?? "current")), commands };
  if (name === "research") return { ...(await researchBundle()), commands };
  if (name === "memory") return { ...(await memoryBundle()), commands };
  if (name === "graph") return { ...(await graphBundle(state)), commands };
  if (name === "workspace") return { ...(await workspaceBundle(state)), commands };
  if (name === "activity") return { ...(await runsBundle(state)), commands };
  if (name === "settings") return { ...(await settingsBundle(state)), commands };
  throw new Error(`unknown screen: ${name}`);
}

async function handleMutationRoute(request: Request, url: URL, state: ControlPlaneState): Promise<Response | null> {
  if (request.method === "GET" || request.method === "OPTIONS") return null;
  const path = url.pathname;
  const body = await parseRequestBody(request).catch(() => ({} as any));
  const now = Date.now();

  if (path === "/api/actions" && request.method === "POST") {
    const actions = await controlRead(state, "actions", [] as any[]);
    const action = { id: crypto.randomUUID(), type: body.type ?? "unknown", target: body.target, payload: body.payload, scope: body.scope ?? "session", status: "queued", createdAt: now };
    actions.push(action); await controlWrite(state, "actions", actions); return ok({ actionId: action.id, status: action.status, result: action }, CAPABILITIES, 202);
  }

  const researchMut = path.match(/^\/api\/research\/([^/]+)(?:\/(pin))?$/);
  if (researchMut && request.method === "DELETE") return ok(await mutateResearch(state, decodeURIComponent(researchMut[1]!), "delete", body), CAPABILITIES);
  if (researchMut && request.method === "POST" && researchMut[2] === "pin") return ok(await mutateResearch(state, decodeURIComponent(researchMut[1]!), "pin", body), CAPABILITIES);

  const approval = path.match(/^\/api\/approvals\/([^/]+)\/(approve|reject|request-changes|revoke)$/);
  if (approval) return ok(await mutateApproval(state, approval[1]!, approval[2]!, body), CAPABILITIES);
  const approvalFile = path.match(/^\/api\/approvals\/([^/]+)\/files\/(.+)\/approve$/);
  if (approvalFile) return ok(await mutateApproval(state, approvalFile[1]!, "approve-file", { ...body, file: decodeURIComponent(approvalFile[2]!) }), CAPABILITIES);
  const approvalHunk = path.match(/^\/api\/approvals\/([^/]+)\/hunks\/([^/]+)\/approve$/);
  if (approvalHunk) return ok(await mutateApproval(state, approvalHunk[1]!, "approve-hunk", { ...body, hunkId: decodeURIComponent(approvalHunk[2]!) }), CAPABILITIES);

  const patch = path.match(/^\/api\/patches\/([^/]+)\/(approve|reject|rollback|request-changes)$/);
  if (patch) return ok(await mutatePatch(state, patch[1]!, patch[2]!, body), CAPABILITIES);
  const patchFile = path.match(/^\/api\/patches\/([^/]+)\/files\/(.+)\/approve$/);
  if (patchFile) return ok(await mutatePatch(state, patchFile[1]!, "approve-file", { ...body, file: decodeURIComponent(patchFile[2]!) }), CAPABILITIES);
  const patchHunk = path.match(/^\/api\/patches\/([^/]+)\/hunks\/([^/]+)\/approve$/);
  if (patchHunk) return ok(await mutatePatch(state, patchHunk[1]!, "approve-hunk", { ...body, hunkId: decodeURIComponent(patchHunk[2]!) }), CAPABILITIES);

  if (path === "/api/memory" && request.method === "POST") return ok(await createMemoryForState(state, body), CAPABILITIES, 201);
  const memory = path.match(/^\/api\/memory\/([^/]+)$/);
  if (memory && request.method === "PATCH") return ok(await patchMemoryForState(state, memory[1]!, body), CAPABILITIES);
  if (memory && request.method === "DELETE") return ok(await deleteMemoryForState(state, memory[1]!), CAPABILITIES);
  const memoryPolicy = path.match(/^\/api\/memory\/([^/]+)\/(pin|unpin|sensitivity|scope|exclude|include)$/);
  if (memoryPolicy) return ok(await patchMemoryPolicyForState(state, memoryPolicy[1]!, memoryPolicy[2]!, body), CAPABILITIES);

  if (path === "/api/chat/threads" && request.method === "POST") return ok(await mutateThread(state, undefined, "create", body), CAPABILITIES, 201);
  const thread = path.match(/^\/api\/chat\/threads\/([^/]+)$/);
  if (thread && request.method === "PATCH") return ok(await mutateThread(state, thread[1]!, "patch", body), CAPABILITIES);
  if (thread && request.method === "DELETE") return ok(await mutateThread(state, thread[1]!, "delete", body), CAPABILITIES);
  const threadAction = path.match(/^\/api\/chat\/threads\/([^/]+)\/(archive|branch)$/);
  if (threadAction) return ok(await mutateThread(state, threadAction[1]!, threadAction[2]!, body), CAPABILITIES, threadAction[2] === "branch" ? 201 : 200);
  const messageAction = path.match(/^\/api\/chat\/messages\/([^/]+)\/(pin|unpin|bookmark|regenerate|edit-resend)$/);
  if (messageAction) return ok(await mutateMessage(state, messageAction[1]!, messageAction[2]!, body), CAPABILITIES);
  const messageBookmarkDelete = path.match(/^\/api\/chat\/messages\/([^/]+)\/bookmark$/);
  if (messageBookmarkDelete && request.method === "DELETE") return ok(await mutateMessage(state, messageBookmarkDelete[1]!, "unbookmark", body), CAPABILITIES);
  if (path === "/api/chat/interrupt") return ok(await runControl(state, "active", "cancel", body), CAPABILITIES);

  const toolInvoke = path.match(/^\/api\/tools\/([^/]+)\/invoke$/);
  if (toolInvoke) return ok(await invokeTool(state, decodeURIComponent(toolInvoke[1]!), body), CAPABILITIES, 202);
  const toolPerm = path.match(/^\/api\/tools\/([^/]+)(?:\/permission)?$/);
  if (toolPerm && request.method === "PATCH") return ok(await setToolPermission(state, decodeURIComponent(toolPerm[1]!), body), CAPABILITIES);

  const run = path.match(/^\/api\/runs\/([^/]+)\/(cancel|retry|pause|resume|steer)$/);
  if (run) return ok(await runControl(state, run[1]!, run[2]!, body), CAPABILITIES);

  if (path === "/api/graph/nodes" && request.method === "POST") return ok(await mutateGraph(state, "nodes", undefined, "create", body), CAPABILITIES, 201);
  const graphNode = path.match(/^\/api\/graph\/nodes\/([^/]+)$/);
  if (graphNode && request.method === "PATCH") return ok(await mutateGraph(state, "nodes", graphNode[1]!, "patch", body), CAPABILITIES);
  if (graphNode && request.method === "DELETE") return ok(await mutateGraph(state, "nodes", graphNode[1]!, "delete", body), CAPABILITIES);
  if (path === "/api/graph/edges" && request.method === "POST") return ok(await mutateGraph(state, "edges", undefined, "create", body), CAPABILITIES, 201);
  const graphEdge = path.match(/^\/api\/graph\/edges\/([^/]+)$/);
  if (graphEdge && request.method === "PATCH") return ok(await mutateGraph(state, "edges", graphEdge[1]!, "patch", body), CAPABILITIES);
  if (graphEdge && request.method === "DELETE") return ok(await mutateGraph(state, "edges", graphEdge[1]!, "delete", body), CAPABILITIES);

  if (path === "/api/workspace/context" && request.method === "POST") return ok(await mutateWorkspaceContext(state, body.action === "remove" ? "remove" : "add", body), CAPABILITIES, body.action === "remove" ? 200 : 201);
  const contextDelete = path.match(/^\/api\/workspace\/context\/([^/]+)$/);
  if (contextDelete && request.method === "DELETE") return ok(await mutateWorkspaceContext(state, "remove", { id: decodeURIComponent(contextDelete[1]!) }), CAPABILITIES);
  const fileChange = path.match(/^\/api\/workspace\/files\/(.+)\/(rollback|accept|discard)$/);
  if (fileChange) return ok(await mutateWorkspaceChange(state, decodeURIComponent(fileChange[1]!), fileChange[2]!, body), CAPABILITIES);
  const allChanges = path.match(/^\/api\/workspace\/changes\/(accept|discard)$/);
  if (allChanges) return ok(await mutateWorkspaceChange(state, "*", allChanges[1]!, body), CAPABILITIES);

  if (path === "/api/models/default" && request.method === "PUT") return ok(await setModelDefault(state, body), CAPABILITIES);
  if (path === "/api/models/fallback" && request.method === "PUT") return ok(await setModelFallback(state, body), CAPABILITIES);

  if (path === "/api/settings" && request.method === "PATCH") return ok(await patchSettings(state, undefined, body), CAPABILITIES);
  if (path === "/api/profile" && request.method === "PATCH") return ok(await patchSettings(state, "profile", body), CAPABILITIES);
  const settingSection = path.match(/^\/api\/settings\/(privacy|memory|theme|shortcuts|agent|cost|profile|instructions|tone)$/);
  if (settingSection && request.method === "PATCH") return ok(await patchSettings(state, settingSection[1]!, body), CAPABILITIES);

  const providerAction = path.match(/^\/api\/providers\/([^/]+)\/(connect|test)$/);
  if (providerAction) return ok(await mutateProvider(state, providerAction[1]!, providerAction[2]!, body), CAPABILITIES);
  const providerDelete = path.match(/^\/api\/providers\/([^/]+)$/);
  if (providerDelete && request.method === "DELETE") return ok(await mutateProvider(state, providerDelete[1]!, "delete", body), CAPABILITIES);
  const providerKeyCreate = path.match(/^\/api\/providers\/([^/]+)\/keys$/);
  if (providerKeyCreate && request.method === "POST") return ok(await mutateProviderKey(state, providerKeyCreate[1]!, undefined, "create", body), CAPABILITIES, 201);
  const providerKeyRotate = path.match(/^\/api\/providers\/([^/]+)\/keys\/([^/]+)\/rotate$/);
  if (providerKeyRotate) return ok(await mutateProviderKey(state, providerKeyRotate[1]!, providerKeyRotate[2]!, "rotate", body), CAPABILITIES);
  const providerKeyDelete = path.match(/^\/api\/providers\/([^/]+)\/keys\/([^/]+)$/);
  if (providerKeyDelete && request.method === "DELETE") return ok(await mutateProviderKey(state, providerKeyDelete[1]!, providerKeyDelete[2]!, "delete", body), CAPABILITIES);

  if (path === "/api/workspaces" && request.method === "POST") return ok(await mutateWorkspace(state, undefined, "create", body), CAPABILITIES, 201);
  if (path === "/api/workspaces/select" && request.method === "POST") return ok(await mutateWorkspace(state, body.id ?? body.path, "select", body), CAPABILITIES);
  const workspace = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (workspace && request.method === "PATCH") return ok(await mutateWorkspace(state, workspace[1]!, "patch", body), CAPABILITIES);
  if (workspace && request.method === "DELETE") return ok(await mutateWorkspace(state, workspace[1]!, "delete", body), CAPABILITIES);

  if (path === "/api/attachments" && request.method === "POST") return ok(await mutateAttachment(state, undefined, "create", body), CAPABILITIES, 201);
  const attachment = path.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachment && request.method === "DELETE") return ok(await mutateAttachment(state, attachment[1]!, "delete", body), CAPABILITIES);

  return null;
}

function controlPath(state: ControlPlaneState, name: string) { return join(state.dataDir ?? DEFAULT_DATA_DIR, `${name}.json`); }
async function controlRead<T>(state: ControlPlaneState, name: string, fallback: T): Promise<T> { return readJson(controlPath(state, name), fallback); }
async function controlWrite(state: ControlPlaneState, name: string, value: unknown) { await writeJson(controlPath(state, name), value); }
function cleanSecret<T extends Record<string, any>>(value: T): T { const copy: any = { ...value }; for (const k of Object.keys(copy)) if (/key|secret|token|password/i.test(k)) copy[k] = copy[k] ? "********" : copy[k]; return copy; }

async function parseRequestBody(request: Request) {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") as any;
    if (file && typeof file === "object") return { name: file.name, size: file.size, mediaType: file.type, content: await file.text().catch(() => undefined) };
    return Object.fromEntries(form.entries());
  }
  return parseJson(request);
}

async function mutateApproval(state: ControlPlaneState, id: string, action: string, body: any) {
  const approvals = await controlRead(state, "approvals", [] as any[]); const item = upsert(approvals, id, { id, type: body.type ?? body.kind ?? "command", title: body.title ?? id, scope: body.scope, risk: body.risk, time: new Date().toISOString(), origin: body.origin, detail: body.detail, createdAt: Date.now() });
  item.status = action === "revoke" ? "pending" : action === "reject" ? "rejected" : action === "request-changes" ? "changes_requested" : "approved"; item.decision = { action, ...body }; item.updatedAt = Date.now(); item.resolution = { action, ...body };
  await controlWrite(state, "approvals", approvals); return { approval: item };
}
async function mutateResearch(state: ControlPlaneState, id: string, action: string, body: any) { const entries = await controlRead(state, "research-overrides", [] as any[]); const item = upsert(entries, id, { id, createdAt: Date.now() }); if (action === "delete") item.deleted = true; if (action === "pin") item.pinned = Boolean(body.pinned ?? true); item.updatedAt = Date.now(); await controlWrite(state, "research-overrides", entries); return { entry: item, ok: true }; }
async function mutatePatch(state: ControlPlaneState, id: string, action: string, body: any) {
  const patches = await controlRead(state, "patches", [] as any[]); const item = upsert(patches, id, { id, title: body.title ?? id, files: [], createdAt: Date.now() });
  item.status = action === "reject" ? "rejected" : action === "rollback" ? "rolled_back" : action === "request-changes" ? "changes_requested" : "approved"; item.updatedAt = Date.now(); (item.actions ??= []).push({ action, ...body, at: Date.now() });
  await controlWrite(state, "patches", patches); return { patch: item };
}
async function createMemoryForState(state: ControlPlaneState, body: any) { const store = await readCpMemoryStore(state); const now = Date.now(); const mem = { id: crypto.randomUUID(), category: body.category ?? "context", content: String(body.content ?? ""), tags: body.tags ?? [], confidence: body.confidence ?? 0.8, temporal: Boolean(body.temporal), created_at: now, updated_at: now, mentions: 0, first_seen: now, entity_refs: [], ...body }; if (!mem.content) throw new Error("memory content required"); store.memories.unshift(mem); await writeCpMemoryStore(state, store); return { memory: mem }; }
async function patchMemoryForState(state: ControlPlaneState, id: string, body: any) { const store = await readCpMemoryStore(state); const mem = findOrThrow(store.memories, id, "memory"); Object.assign(mem, body, { id, updated_at: Date.now() }); await writeCpMemoryStore(state, store); return { memory: mem }; }
async function deleteMemoryForState(state: ControlPlaneState, id: string) { const store = await readCpMemoryStore(state); const before = store.memories.length; store.memories = store.memories.filter((m: any) => m.id !== id); await writeCpMemoryStore(state, store); return { deleted: before !== store.memories.length, id }; }
async function patchMemoryPolicyForState(state: ControlPlaneState, id: string, action: string, body: any) { const patch: any = {}; if (action === "pin") patch.pinned = true; if (action === "unpin") patch.pinned = false; if (action === "exclude") patch.excluded = true; if (action === "include") patch.excluded = false; if (action === "sensitivity") patch.sensitivity = body.sensitivity; if (action === "scope") patch.workspace_scope = body.workspaceScope ?? body.scope ?? []; return patchMemoryForState(state, id, patch); }
async function readCpMemoryStore(state: ControlPlaneState) { return state.memoryFile ? readJson(state.memoryFile, { version: 4, profile: {}, memories: [] as any[] }) : readMemoryStore(); }
async function writeCpMemoryStore(state: ControlPlaneState, store: unknown) { return state.memoryFile ? writeJson(state.memoryFile, store) : writeMemoryStore(store); }

async function mutateThread(state: ControlPlaneState, id: string | undefined, action: string, body: any) { const store = await controlRead(state, "chat-threads", { threads: [] as any[] }); if (action === "create") { const thread = { id: crypto.randomUUID(), title: body.title ?? "New thread", archived: false, messages: [], createdAt: Date.now(), updatedAt: Date.now() }; store.threads.unshift(thread); await controlWrite(state, "chat-threads", store); return { thread }; } const thread = upsert(store.threads, id!, { id, title: id, messages: [], createdAt: Date.now() }); if (action === "patch") Object.assign(thread, body, { updatedAt: Date.now() }); if (action === "delete") thread.deleted = true; if (action === "archive") thread.archived = true; if (action === "branch") { const fork = { ...thread, ...body, id: crypto.randomUUID(), title: body.title ?? `${thread.title} fork`, branchedFrom: thread.id, createdAt: Date.now(), updatedAt: Date.now() }; store.threads.unshift(fork); await controlWrite(state, "chat-threads", store); return { thread: fork }; } await controlWrite(state, "chat-threads", store); return { thread }; }
async function mutateMessage(state: ControlPlaneState, id: string, action: string, body: any) { const messages = await controlRead(state, "message-actions", [] as any[]); const item = upsert(messages, id, { id, createdAt: Date.now() }); Object.assign(item, { updatedAt: Date.now() }); if (action === "pin") item.pinned = body.pinned ?? true; if (action === "unpin") item.pinned = false; if (action === "bookmark") item.bookmarked = body.bookmarked ?? true; if (action === "unbookmark") item.bookmarked = false; if (["regenerate", "edit-resend"].includes(action)) item.request = { action, ...body }; await controlWrite(state, "message-actions", messages); return { message: item }; }
async function invokeTool(state: ControlPlaneState, name: string, body: any) { const invocations = await controlRead(state, "tool-invocations", [] as any[]); const invocation = { id: crypto.randomUUID(), name, input: body, status: "queued", createdAt: Date.now() }; invocations.unshift(invocation); await controlWrite(state, "tool-invocations", invocations); return { invocation }; }
async function setToolPermission(state: ControlPlaneState, name: string, body: any) { const perms = await controlRead(state, "tool-permissions", {} as any); perms[name] = { name, mode: body.mode ?? "ask", scope: body.scope ?? "workspace", updatedAt: Date.now() }; await controlWrite(state, "tool-permissions", perms); return { permission: perms[name] }; }
async function runControl(state: ControlPlaneState, id: string, action: string, body: any) { const controls = await controlRead(state, "run-controls", [] as any[]); const control = { id: crypto.randomUUID(), runId: id, action, instruction: body.instruction, status: "queued", createdAt: Date.now() }; controls.unshift(control); await controlWrite(state, "run-controls", controls); return { control }; }
async function mutateGraph(state: ControlPlaneState, kind: "nodes" | "edges", id: string | undefined, action: string, body: any) { const graph = await controlRead(state, "graph-overrides", { nodes: [] as any[], edges: [] as any[] }); if (action === "create") { const item = { id: body.id ?? crypto.randomUUID(), ...body, createdAt: Date.now(), updatedAt: Date.now() }; graph[kind].push(item); await controlWrite(state, "graph-overrides", graph); return { [kind.slice(0, -1)]: item }; } const item = findOrThrow(graph[kind], id!, kind.slice(0, -1)); if (action === "patch") Object.assign(item, body, { id, updatedAt: Date.now() }); if (action === "delete") item.deleted = true; await controlWrite(state, "graph-overrides", graph); return { [kind.slice(0, -1)]: item }; }
async function mutateWorkspaceContext(state: ControlPlaneState, action: string, body: any) { const context = await controlRead(state, "workspace-context", [] as any[]); if (action === "add") { const item = { id: body.id ?? crypto.randomUUID(), ...body, createdAt: Date.now() }; context.push(item); await controlWrite(state, "workspace-context", context); return { context: item }; } const before = context.length; const next = context.filter((x: any) => x.id !== body.id && x.path !== body.id); await controlWrite(state, "workspace-context", next); return { removed: before - next.length, id: body.id }; }
async function mutateWorkspaceChange(state: ControlPlaneState, file: string, action: string, body: any) { const changes = await controlRead(state, "workspace-changes", [] as any[]); const change = { id: crypto.randomUUID(), file, action, payload: body, createdAt: Date.now() }; changes.unshift(change); await controlWrite(state, "workspace-changes", changes); return { change }; }
async function selectModel(state: ControlPlaneState, body: any) { const models = await controlRead(state, "models", { current: undefined as any, defaults: {} as Record<string, unknown>, fallbackChain: [] as any[], selections: [] as any[] }); const selected = normalizeModel({ id: body.modelId ?? body.id ?? body.model, provider: body.provider, name: body.name }); models.current = selected; models.selections.unshift({ model: selected, scope: body.scope ?? "session", createdAt: Date.now() }); if (state.runtime) state.runtime.model = selected; await controlWrite(state, "models", models); return { current: selected, switchability: { supported: false, appliedAs: "control-plane-selection" } }; }
async function setModelDefault(state: ControlPlaneState, body: any) { const models = await controlRead(state, "models", { defaults: {} as Record<string, unknown>, fallbackChain: [] as any[] }); models.defaults[String(body.scope ?? "workspace")] = body.modelId ?? body.id ?? body.model; await controlWrite(state, "models", models); return models; }
async function setModelFallback(state: ControlPlaneState, body: any) { const models = await controlRead(state, "models", { defaults: {}, fallbackChain: [] as any[] }); models.fallbackChain = body.fallbackChain ?? body.models ?? []; await controlWrite(state, "models", models); return models; }
async function patchSettings(state: ControlPlaneState, section: string | undefined, body: any) { const settings = await controlRead(state, "settings", {} as any); if (section) settings[section] = { ...(settings[section] ?? {}), ...body }; else Object.assign(settings, body); settings.updatedAt = Date.now(); await controlWrite(state, "settings", settings); return settings; }
async function mutateProvider(state: ControlPlaneState, id: string, action: string, body: any) { const providers = await controlRead(state, "providers", [] as any[]); const p = upsert(providers, id, { id, keys: [], createdAt: Date.now() }); if (action === "delete") p.deleted = true; else Object.assign(p, cleanSecret(body), { status: action === "test" ? "tested" : "connected", updatedAt: Date.now() }); await controlWrite(state, "providers", providers); return { provider: p }; }
async function mutateProviderKey(state: ControlPlaneState, providerId: string, keyId: string | undefined, action: string, body: any) { const providers = await controlRead(state, "providers", [] as any[]); const p = upsert(providers, providerId, { id: providerId, keys: [], createdAt: Date.now() }); if (action === "create") p.keys.push({ id: crypto.randomUUID(), label: body.label ?? "API key", redacted: body.key ? "********" : undefined, createdAt: Date.now() }); else { const k = findOrThrow(p.keys, keyId!, "provider key"); if (action === "rotate") Object.assign(k, { rotatedAt: Date.now(), redacted: body.key ? "********" : k.redacted }); if (action === "delete") k.deleted = true; } await controlWrite(state, "providers", providers); return { provider: p }; }
async function mutateWorkspace(state: ControlPlaneState, id: string | undefined, action: string, body: any) { const workspaces = await controlRead(state, "workspaces", [] as any[]); if (action === "create") { const w = { id: body.id ?? crypto.randomUUID(), name: body.name ?? body.path ?? "Workspace", path: body.path ?? state.cwd, settings: body.settings ?? {}, createdAt: Date.now() }; workspaces.push(w); await controlWrite(state, "workspaces", workspaces); return { workspace: w }; } const w = upsert(workspaces, id!, { id, path: body.path ?? id, name: body.name ?? id, settings: {}, createdAt: Date.now() }); if (action === "select") workspaces.forEach((x: any) => x.active = x.id === id || x.path === id); if (action === "patch") Object.assign(w, body, { updatedAt: Date.now() }); if (action === "delete") w.deleted = true; await controlWrite(state, "workspaces", workspaces); return { workspace: w }; }
async function mutateAttachment(state: ControlPlaneState, id: string | undefined, action: string, body: any) { const attachments = await controlRead(state, "attachments", [] as any[]); if (action === "create") { const a = { id: crypto.randomUUID(), name: body.name ?? "attachment", mediaType: body.mediaType, size: body.content ? String(body.content).length : body.size, content: body.content, url: undefined as any, createdAt: Date.now() }; a.url = `/api/attachments/${a.id}`; attachments.push(a); await controlWrite(state, "attachments", attachments); return { attachment: { ...a, content: undefined }, id: a.id, url: a.url, name: a.name, size: a.size }; } const a = findOrThrow(attachments, id!, "attachment"); a.deleted = true; a.updatedAt = Date.now(); await controlWrite(state, "attachments", attachments); return { attachment: { ...a, content: undefined }, ok: true }; }
function upsert(items: any[], id: string, seed: any) { let item = items.find((x: any) => x.id === id); if (!item) { item = { ...seed, id }; items.push(item); } return item; }
function findOrThrow(items: any[], id: string, label: string) { const item = items.find((x: any) => x.id === id); if (!item) throw new Error(`${label} not found: ${id}`); return item; }

function eventStream(since?: string) {
  const now = new Date().toISOString();
  const events = [
    { type: "agent.state", timestamp: now, payload: { state: "idle", since } },
    { type: "cost.updated", timestamp: now, payload: { today: "$0.00" } },
  ];
  const payload = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(payload, { headers: { ...corsHeaders(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

function corsHeaders() { return { "access-control-allow-origin": "http://127.0.0.1", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" }; }
