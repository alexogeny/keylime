import { join } from "node:path";
import { ok, fail, parseJson } from "./envelope";
import { CAPABILITIES, buildGraph, inferAgentState, normalizeMessages, normalizeModel, normalizeResearchDetail, normalizeResearchSummary, normalizeToolCall, splitMemory } from "./normalizers";
import { DEFAULT_DATA_DIR, listWorkspaceFiles, readJson, readMemoryStore, readResearchEntry, readResearchIndex, readToolResult, readToolResultIndex } from "./stores";
import type { ControlPlaneState, ScreenCommand, SystemCapabilityMap } from "./types";

const systemCaps: SystemCapabilityMap = { chat: true, streaming: false, memory: true, structuredMemory: true, research: true, files: true, patches: false, modelSwitching: false, approvals: false, toolInspection: true, costTracking: false, runTracing: true, knowledgeGraph: true };

export async function handleControlPlaneRequest(request: Request, state: ControlPlaneState): Promise<Response> {
  const url = new URL(request.url);
  if (state.token && request.headers.get("authorization") !== `Bearer ${state.token}`) return fail("UNAUTHORIZED", "Bearer token required", 401);
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === "/api/system" && request.method === "GET") return ok({ backend: "pi", cwd: state.cwd, authenticated: Boolean(state.token), capabilities: systemCaps }, CAPABILITIES);
    if (url.pathname === "/api/status" && request.method === "GET") return ok(await statusBundle(state), CAPABILITIES);
    if (url.pathname === "/api/events" && request.method === "GET") return eventStream();

    if (url.pathname === "/api/chat/threads" && request.method === "GET") return ok(await chatThreads(state), CAPABILITIES);
    const chatThread = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)$/);
    if (chatThread && request.method === "GET") return ok(await chatThreadBundle(state, decodeURIComponent(chatThread[1]!)), CAPABILITIES);
    const chatMessage = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)\/messages$/);
    if (chatMessage && request.method === "POST") return ok(await sendChatMessage(state, await parseJson(request)), CAPABILITIES, 202);

    if (url.pathname === "/api/runs" && request.method === "GET") return ok(await runsBundle(state), CAPABILITIES);
    const run = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (run && request.method === "GET") return ok(await runDetail(state, decodeURIComponent(run[1]!)), CAPABILITIES);

    if (url.pathname === "/api/research" && request.method === "GET") return ok(await researchBundle(url.searchParams.get("q") ?? ""), CAPABILITIES);
    const research = url.pathname.match(/^\/api\/research\/([^/]+)$/);
    if (research && request.method === "GET") return ok(await researchDetail(decodeURIComponent(research[1]!)), CAPABILITIES);

    if (url.pathname === "/api/memory" && request.method === "GET") return ok(await memoryBundle(), CAPABILITIES);
    if (url.pathname === "/api/memory/items" && request.method === "GET") { const m = await memoryBundle(); return ok({ items: [...m.pinned, ...m.memories] }, CAPABILITIES); }

    if (url.pathname === "/api/graph" && request.method === "GET") return ok(await graphBundle(state), CAPABILITIES);
    const graphNode = url.pathname.match(/^\/api\/graph\/nodes\/(.+)$/);
    if (graphNode && request.method === "GET") return ok(await graphNodeBundle(state, decodeURIComponent(graphNode[1]!)), CAPABILITIES);

    if (url.pathname === "/api/workspaces" && request.method === "GET") return ok({ active: state.cwd, workspaces: [{ id: state.cwd, name: state.cwd.split("/").pop() || state.cwd, path: state.cwd, active: true }] }, CAPABILITIES);
    if (url.pathname === "/api/workspace" && request.method === "GET") return ok(await workspaceBundle(state), CAPABILITIES);
    if (url.pathname === "/api/workspace/files" && request.method === "GET") return ok({ root: state.cwd, tree: await listWorkspaceFiles(state.cwd) }, CAPABILITIES);

    if (url.pathname === "/api/tools" && request.method === "GET") return ok({ tools: [], note: "Available tool definitions are backend-specific; inspect /api/tool-calls for observed calls." }, CAPABILITIES);
    if (url.pathname === "/api/tool-calls" && request.method === "GET") return ok({ calls: (await readToolResultIndex(state.cwd)).map(normalizeToolCall) }, CAPABILITIES);
    const toolCall = url.pathname.match(/^\/api\/tool-calls\/([^/]+)$/);
    if (toolCall && request.method === "GET") { const raw = await readToolResult(state.cwd, decodeURIComponent(toolCall[1]!)); return ok({ call: normalizeToolCall(raw), input: raw.input ?? raw.args ?? raw.parameters, output: raw.output ?? raw.result, raw }, CAPABILITIES); }

    if (url.pathname === "/api/models" && request.method === "GET") return ok(modelsBundle(state), CAPABILITIES);
    if (url.pathname === "/api/models/select" && request.method === "POST") return fail("MODEL_SWITCH_INTERACTIVE_ONLY", "This backend only exposes model switching through the interactive harness unless a compatible adapter implements it.", 409);
    if (url.pathname === "/api/approvals" && request.method === "GET") return ok({ pending: [], history: [] }, CAPABILITIES);
    if (url.pathname === "/api/patches" && request.method === "GET") return ok({ patches: [] }, CAPABILITIES);
    if (url.pathname === "/api/settings" && request.method === "GET") return ok(await settingsBundle(state), CAPABILITIES);
    if (url.pathname === "/api/providers" && request.method === "GET") return ok({ providers: [], note: "Provider connection management requires a backend adapter." }, CAPABILITIES);
    if (url.pathname === "/api/attachments" && request.method === "GET") return ok({ attachments: [] }, CAPABILITIES);
    if (/^\/api\/attachments\/[^/]+$/.test(url.pathname) && request.method === "GET") return fail("NOT_FOUND", "Attachment not found", 404);

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
  return { workspace: { name: state.cwd.split("/").pop() || state.cwd, path: state.cwd }, model: normalizeModel(runtime.model), agent: { state: inferAgentState(runtime), currentTask: undefined }, meters: { tokens: {}, cost: {}, memory: { state: "active", detail: "structured memory available" }, research: { state: "active" }, tools: { state: "active" }, approvalsPending: 0 } };
}

async function chatThreads(state: ControlPlaneState) {
  const messages = normalizeMessages(state.getEntries?.() ?? []);
  return { threads: [{ id: "current", title: "Current session", updatedAt: Date.now(), messageCount: messages.length, topics: [] }] };
}

async function chatThreadBundle(state: ControlPlaneState, id: string) {
  const messages = normalizeMessages(state.getEntries?.() ?? []);
  return { thread: { id, title: id === "current" ? "Current session" : id, updatedAt: Date.now(), messageCount: messages.length, topics: [] }, messages, runs: [], pinned: [], bookmarks: [] };
}

async function sendChatMessage(state: ControlPlaneState, body: any) {
  const content = String(body.content ?? body.message ?? "").trim();
  if (!content) throw new Error("message content required");
  await state.sendUserMessage?.(content, { deliverAs: body.mode ?? "followUp" });
  return { queued: Boolean(state.sendUserMessage), message: { role: "user", content } };
}

async function runsBundle(state: ControlPlaneState) {
  const messages = normalizeMessages(state.getEntries?.() ?? []);
  return { runs: messages.map((m, i) => ({ id: `run-${i}`, threadId: "current", prompt: m.role === "user" ? m.content : undefined, state: "done", startedAt: m.createdAt, model: m.model })) };
}

async function runDetail(state: ControlPlaneState, id: string) {
  return { run: { id, threadId: "current", state: inferAgentState(state.runtime), model: normalizeModel(state.runtime?.model) }, context: { instructions: [], memories: [], research: [], files: [], workspaceContext: [state.cwd] }, steps: [], toolCalls: (await readToolResultIndex(state.cwd)).map(normalizeToolCall), filesRead: [], filesWritten: [], patches: [], approvals: [], errors: [] };
}

async function researchBundle(q = "") {
  const entries = (await readResearchIndex(q)).map(normalizeResearchSummary);
  const facet = (name: "tags" | "categories") => Object.entries(entries.flatMap((e: any) => e[name] ?? []).reduce((a: any, x: string) => (a[x] = (a[x] ?? 0) + 1, a), {})).map(([value, count]) => ({ value, count }));
  return { entries, facets: { tags: facet("tags"), sources: [], topics: facet("categories") } };
}

async function researchDetail(id: string) {
  const entry = await readResearchEntry(id);
  if (!entry) throw new Error("research entry not found");
  const related = (await readResearchIndex("")) .filter((e: any) => e.id !== id).slice(0, 8).map(normalizeResearchSummary);
  return normalizeResearchDetail(entry, related);
}

async function memoryBundle() {
  const store = await readMemoryStore();
  const split = splitMemory(store);
  return { ...split, timelines: [{ id: "profile", label: "Profile timeline", events: split.timeline }], entities: [], relationships: [], preferences: split.memories.filter(m => m.category === "preference"), projects: [], recent: [...split.pinned, ...split.memories].slice(0, 20), sensitive: [...split.pinned, ...split.memories].filter(m => m.privacy?.sensitivity && m.privacy.sensitivity !== "baseline"), stats: { total: (store.memories ?? []).length, timeline: split.timeline.length, pinned: split.pinned.length } };
}

async function graphBundle(state: ControlPlaneState) {
  const memory = splitMemory(await readMemoryStore());
  const research = (await readResearchIndex("")).slice(0, 100).map(normalizeResearchSummary);
  return buildGraph(memory, research, state.cwd);
}

async function graphNodeBundle(state: ControlPlaneState, id: string) {
  const graph = await graphBundle(state);
  return { node: graph.nodes.find(n => n.id === id) ?? { id, label: id, type: "workspace" }, adjacent: graph.nodes.filter(n => n.id !== id).slice(0, 30), edges: graph.edges.filter(e => e.from === id || e.to === id), memories: (await memoryBundle()).recent, research: (await researchBundle()).entries.slice(0, 12), chats: (await chatThreads(state)).threads, files: [], timeline: (await memoryBundle()).timeline, toolActivity: (await readToolResultIndex(state.cwd)).slice(0, 20).map(normalizeToolCall) };
}

async function workspaceBundle(state: ControlPlaneState) {
  const files = await listWorkspaceFiles(state.cwd, 80);
  return { workspace: { id: state.cwd, name: state.cwd.split("/").pop() || state.cwd, path: state.cwd, active: true }, instructions: [], activeContext: [], recentFiles: files.filter(f => f.kind === "file").slice(0, 20), modifiedFiles: [], generatedFiles: [], attachedFiles: [], projectMemory: (await memoryBundle()).projects };
}

function modelsBundle(state: ControlPlaneState) {
  return { current: normalizeModel(state.runtime?.model), models: state.runtime?.model ? [normalizeModel(state.runtime.model)].filter(Boolean) : [], providers: [], fallbackChain: [], defaults: {}, switchability: { supported: false, reason: "Pi model switching is interactive-only unless a backend adapter implements direct selection." } };
}

async function settingsBundle(state: ControlPlaneState) {
  const profile = await readJson(join(state.dataDir ?? DEFAULT_DATA_DIR, "profile.json"), {});
  return { profile, workspaces: [{ id: state.cwd, path: state.cwd }], privacy: {}, memory: {}, models: {}, tools: {}, cost: {}, theme: {}, shortcuts: [], agent: {} };
}

async function screenBundle(state: ControlPlaneState, name: string, id?: string) {
  const commands: ScreenCommand[] = [{ id: "palette", label: "Command palette", shortcut: "⌘K" }];
  if (name === "dashboard") return { status: await statusBundle(state), threads: (await chatThreads(state)).threads, activity: (await runsBundle(state)).runs, commands };
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
  const body = await parseJson(request).catch(() => ({}));

  if (path === "/api/actions" && request.method === "POST") return ok({ actionId: crypto.randomUUID(), status: "unsupported", type: body.type, target: body.target, result: null }, CAPABILITIES, 202);

  if (/^\/api\/approvals\/[^/]+\/(approve|reject|request-changes)$/.test(path)) return unsupported("approval.resolve", path);
  if (/^\/api\/approvals\/[^/]+\/files\/.+\/approve$/.test(path)) return unsupported("approval.file.approve", path);
  if (/^\/api\/approvals\/[^/]+\/hunks\/[^/]+\/approve$/.test(path)) return unsupported("approval.hunk.approve", path);

  if (/^\/api\/patches\/[^/]+\/(approve|reject|rollback|request-changes)$/.test(path)) return unsupported("patch.resolve", path);
  if (/^\/api\/patches\/[^/]+\/files\/.+\/approve$/.test(path)) return unsupported("patch.file.approve", path);
  if (/^\/api\/patches\/[^/]+\/hunks\/[^/]+\/approve$/.test(path)) return unsupported("patch.hunk.approve", path);

  if (path === "/api/memory" && request.method === "POST") return unsupported("memory.create", path);
  if (/^\/api\/memory\/[^/]+$/.test(path) && ["PATCH", "DELETE"].includes(request.method)) return unsupported("memory.mutate", path);
  if (/^\/api\/memory\/[^/]+\/(pin|unpin|sensitivity|scope|exclude|include)$/.test(path)) return unsupported("memory.policy", path);

  if (path === "/api/chat/threads" && request.method === "POST") return unsupported("chat.thread.create", path);
  if (/^\/api\/chat\/threads\/[^/]+$/.test(path) && ["PATCH", "DELETE"].includes(request.method)) return unsupported("chat.thread.mutate", path);
  if (/^\/api\/chat\/threads\/[^/]+\/(archive|branch)$/.test(path)) return unsupported("chat.thread.action", path);
  if (/^\/api\/chat\/messages\/[^/]+\/(pin|unpin|bookmark|regenerate|edit-resend)$/.test(path) || (/^\/api\/chat\/messages\/[^/]+\/bookmark$/.test(path) && request.method === "DELETE")) return unsupported("chat.message.action", path);
  if (path === "/api/chat/interrupt") return unsupported("chat.interrupt", path);

  if (/^\/api\/tools\/[^/]+\/invoke$/.test(path)) return unsupported("tool.invoke", path);
  if (/^\/api\/tools\/[^/]+\/permission$/.test(path) && request.method === "PATCH") return unsupported("tool.permission", path);

  if (/^\/api\/runs\/[^/]+\/(cancel|retry|pause|resume|steer)$/.test(path)) return unsupported("run.control", path);

  if (path === "/api/graph/nodes" && request.method === "POST") return unsupported("graph.node.create", path);
  if (/^\/api\/graph\/nodes\/[^/]+$/.test(path) && ["PATCH", "DELETE"].includes(request.method)) return unsupported("graph.node.mutate", path);
  if (path === "/api/graph/edges" && request.method === "POST") return unsupported("graph.edge.create", path);
  if (/^\/api\/graph\/edges\/[^/]+$/.test(path) && ["PATCH", "DELETE"].includes(request.method)) return unsupported("graph.edge.mutate", path);

  if (path === "/api/workspace/context" && ["POST", "DELETE"].includes(request.method)) return unsupported("workspace.context", path);
  if (/^\/api\/workspace\/context\/[^/]+$/.test(path) && request.method === "DELETE") return unsupported("workspace.context.remove", path);
  if (/^\/api\/workspace\/files\/.+\/(rollback|accept|discard)$/.test(path)) return unsupported("workspace.file.change", path);
  if (/^\/api\/workspace\/changes\/(accept|discard)$/.test(path)) return unsupported("workspace.changes", path);

  if (path === "/api/models/default" && request.method === "PUT") return unsupported("model.default", path);
  if (path === "/api/models/fallback" && request.method === "PUT") return unsupported("model.fallback", path);

  if (path === "/api/settings" && request.method === "PATCH") return unsupported("settings.patch", path);
  if (path === "/api/profile" && request.method === "PATCH") return unsupported("profile.patch", path);
  if (/^\/api\/settings\/(privacy|memory|theme|shortcuts|agent|cost)$/.test(path) && request.method === "PATCH") return unsupported("settings.section.patch", path);

  if (/^\/api\/providers\/[^/]+\/(connect|test)$/.test(path)) return unsupported("provider.connection", path);
  if (/^\/api\/providers\/[^/]+$/.test(path) && request.method === "DELETE") return unsupported("provider.delete", path);
  if (/^\/api\/providers\/[^/]+\/keys$/.test(path) && request.method === "POST") return unsupported("provider.key.create", path);
  if (/^\/api\/providers\/[^/]+\/keys\/[^/]+\/(rotate)$/.test(path)) return unsupported("provider.key.rotate", path);
  if (/^\/api\/providers\/[^/]+\/keys\/[^/]+$/.test(path) && request.method === "DELETE") return unsupported("provider.key.delete", path);

  if (path === "/api/workspaces" && request.method === "POST") return unsupported("workspace.create", path);
  if (path === "/api/workspaces/select" && request.method === "POST") return unsupported("workspace.select", path);
  if (/^\/api\/workspaces\/[^/]+$/.test(path) && ["PATCH", "DELETE"].includes(request.method)) return unsupported("workspace.mutate", path);

  if (path === "/api/attachments" && request.method === "POST") return unsupported("attachment.upload", path);
  if (/^\/api\/attachments\/[^/]+$/.test(path) && ["GET", "DELETE"].includes(request.method)) return unsupported("attachment.mutate", path);

  return null;
}

function unsupported(action: string, path: string) {
  return fail("BACKEND_UNSUPPORTED", `This backend does not currently support ${action}.`, 501, { action, path, requiredCapability: action.split(".")[0] });
}

function eventStream() {
  const payload = `event: heartbeat\ndata: ${JSON.stringify({ timestamp: Date.now(), state: "idle" })}\n\n`;
  return new Response(payload, { headers: { ...corsHeaders(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

function corsHeaders() { return { "access-control-allow-origin": "http://127.0.0.1", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" }; }
