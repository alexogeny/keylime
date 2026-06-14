import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = join(homedir(), ".pi", "data", "keylime-web");
const PROFILE_FILE = join(DATA_DIR, "profile.json");
const MEMORY_FILE = join(homedir(), ".pi", "data", "user-memory", "memories.json");
const DEFAULT_PORT = Number(process.env.KEYLIME_WEB_UI_PORT ?? 49713);

export type WebProfile = {
  nickname: string;
  avatarDataUrl?: string;
  theme: "aurora" | "graphite" | "rose" | "system";
  customInstructions: string;
};

export type WebUiState = {
  cwd: string;
  token?: string;
  sendUserMessage?: (text: string, options?: any) => void;
  getEntries?: () => any[];
};

const DEFAULT_PROFILE: WebProfile = { nickname: "", theme: "aurora", customInstructions: "" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function text(data: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(data, { status, headers: { "content-type": contentType } });
}
async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}
async function findToolResultPath(cwd: string, id: string): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Unsafe tool result id");
  const base = join(cwd, ".pi", "tool-results");
  const direct = normalize(join(base, `${id}.json`));
  if (!direct.startsWith(base)) throw new Error("Unsafe tool result path");
  if (existsSync(direct)) return direct;
  const manifest = await listToolResults(cwd);
  const hit = manifest.find((entry: any) => entry.id === id || entry.result_id === id);
  const stored = typeof hit?.stored_at === "string" ? normalize(join(cwd, hit.stored_at)) : "";
  if (stored && stored.startsWith(base) && existsSync(stored)) return stored;
  throw new Error("Tool result not found");
}
function trimString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function sanitizeProfile(input: any): WebProfile {
  const theme = ["aurora", "graphite", "rose", "system"].includes(input?.theme) ? input.theme : "aurora";
  const avatar = typeof input?.avatarDataUrl === "string" && /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(input.avatarDataUrl) && input.avatarDataUrl.length < 1_500_000
    ? input.avatarDataUrl
    : undefined;
  return {
    nickname: trimString(input?.nickname, 80),
    avatarDataUrl: avatar,
    theme,
    customInstructions: trimString(input?.customInstructions, 8000),
  };
}

export function webUiStateForTests(partial: Partial<WebUiState> = {}): WebUiState {
  return { cwd: process.cwd(), ...partial };
}

async function listToolResults(cwd: string) {
  return readJson(join(cwd, ".pi", "tool-results", "index.json"), [] as any[]);
}
async function readMemoryStore() {
  const store = await readJson(MEMORY_FILE, { version: 1, memories: [] as any[] });
  store.memories ||= [];
  return store;
}
async function writeMemoryStore(store: any) {
  await mkdir(dirname(MEMORY_FILE), { recursive: true });
  await writeFile(MEMORY_FILE, JSON.stringify(store, null, 2), "utf8");
}
function normalizeMemoryPatch(input: any) {
  const patch: Record<string, unknown> = {};
  if (typeof input.content === "string") patch.content = input.content.slice(0, 20_000);
  if (typeof input.category === "string") patch.category = input.category;
  if (typeof input.subcategory === "string") patch.subcategory = input.subcategory.slice(0, 100);
  if (Array.isArray(input.tags)) patch.tags = input.tags.map((t: unknown) => String(t).slice(0, 64)).slice(0, 40);
  if (typeof input.confidence === "number") patch.confidence = Math.max(0, Math.min(1, input.confidence));
  if (typeof input.sensitivity === "string") patch.sensitivity = input.sensitivity;
  return patch;
}

export async function handleWebUiRequest(request: Request, state: WebUiState): Promise<Response> {
  const url = new URL(request.url);
  if (state.token && request.headers.get("authorization") !== `Bearer ${state.token}`) return json({ error: "unauthorized" }, 401);

  try {
    if (url.pathname === "/" && request.method === "GET") return text(renderWebUiHtml(), 200, "text/html; charset=utf-8");
    if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, cwd: state.cwd, authenticated: Boolean(state.token) });

    if (url.pathname === "/api/profile") {
      if (request.method === "GET") return json(await readJson(PROFILE_FILE, DEFAULT_PROFILE));
      if (request.method === "PUT") {
        const profile = sanitizeProfile(await request.json());
        await writeJson(PROFILE_FILE, profile);
        return json(profile);
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/api/memories") {
      const store = await readMemoryStore();
      if (request.method === "GET") return json(store);
      if (request.method === "POST") {
        const body = await request.json();
        const now = Date.now();
        const mem = { id: crypto.randomUUID(), tags: [], confidence: 0.8, created_at: now, updated_at: now, ...normalizeMemoryPatch(body) };
        if (!mem.content || !mem.category) return json({ error: "content and category required" }, 400);
        store.memories.unshift(mem);
        await writeMemoryStore(store);
        return json(mem, 201);
      }
      return json({ error: "method not allowed" }, 405);
    }

    const memoryMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (memoryMatch) {
      const store = await readMemoryStore();
      const id = decodeURIComponent(memoryMatch[1]!);
      const index = store.memories.findIndex((m: any) => m.id === id);
      if (index < 0) return json({ error: "not found" }, 404);
      if (request.method === "PATCH") {
        store.memories[index] = { ...store.memories[index], ...normalizeMemoryPatch(await request.json()), updated_at: Date.now() };
        await writeMemoryStore(store);
        return json(store.memories[index]);
      }
      if (request.method === "DELETE") {
        const [deleted] = store.memories.splice(index, 1);
        await writeMemoryStore(store);
        return json({ deleted });
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/api/tool-results" && request.method === "GET") return json(await listToolResults(state.cwd));
    const toolMatch = url.pathname.match(/^\/api\/tool-results\/([^/]+)$/);
    if (toolMatch && request.method === "GET") {
      const raw = await readFile(await findToolResultPath(state.cwd, decodeURIComponent(toolMatch[1]!)), "utf8");
      return text(raw, 200, "application/json; charset=utf-8");
    }

    if (url.pathname === "/api/thread" && request.method === "GET") return json({ entries: state.getEntries?.() ?? [] });
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json();
      const message = trimString(body?.message, 20_000).trim();
      if (!message) return json({ error: "message required" }, 400);
      state.sendUserMessage?.(message, { deliverAs: "followUp" });
      return json({ queued: Boolean(state.sendUserMessage), message });
    }

    return json({ error: "not found" }, 404);
  } catch (error: any) {
    return json({ error: error?.message ?? String(error) }, 500);
  }
}

async function nodeRequestToWeb(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method, headers: req.headers as any, body: chunks.length ? Buffer.concat(chunks) : undefined } as any);
}
async function sendResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

let server: Server | null = null;
let serverUrl = "";
let latestState: WebUiState | null = null;

async function startServer(pi: ExtensionAPI, ctx: any, port = DEFAULT_PORT) {
  if (server) return serverUrl;
  latestState = {
    cwd: ctx.cwd,
    token: process.env.KEYLIME_WEB_UI_TOKEN,
    sendUserMessage: (text, options) => (pi as any).sendUserMessage?.(text, options),
    getEntries: () => ctx.sessionManager?.getEntries?.() ?? [],
  };
  server = createServer(async (req, res) => sendResponse(res, await handleWebUiRequest(await nodeRequestToWeb(req), latestState!)));
  await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  serverUrl = `http://127.0.0.1:${actualPort}/`;
  return serverUrl;
}
async function stopServer() {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  serverUrl = "";
}

export function renderWebUiHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keylime Browser UI</title><style>
:root{color-scheme:dark;--bg:#090a12;--panel:rgba(255,255,255,.075);--panel2:rgba(255,255,255,.11);--text:#f7f3ff;--muted:#aaa3bd;--accent:#8b5cf6;--hot:#22d3ee;--ok:#34d399;--bad:#fb7185}*{box-sizing:border-box}body{margin:0;font:14px/1.45 Inter,ui-sans-serif,system-ui;background:radial-gradient(900px at 10% 0%,#312e81 0,#090a12 45%),radial-gradient(700px at 100% 10%,#164e63 0,#090a12 38%);color:var(--text)}button,input,textarea,select{font:inherit}button{border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--hot));color:white;padding:10px 14px;font-weight:700;cursor:pointer}.ghost{background:var(--panel2);color:var(--text)}.app{display:grid;grid-template-columns:270px 1fr;min-height:100vh}.side{padding:24px;border-right:1px solid #ffffff18;background:#05060bb8;backdrop-filter:blur(18px);position:sticky;top:0;height:100vh}.brand{font-size:23px;font-weight:900;letter-spacing:-.04em}.brand span{color:var(--hot)}.nav{display:grid;gap:8px;margin-top:28px}.nav button{text-align:left;background:transparent;color:var(--muted)}.nav button.active,.nav button:hover{background:var(--panel);color:var(--text)}main{padding:28px;max-width:1260px;width:100%;margin:auto}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.card{grid-column:span 12;background:var(--panel);border:1px solid #ffffff18;border-radius:24px;padding:20px;box-shadow:0 20px 60px #0005;backdrop-filter:blur(18px)}.half{grid-column:span 6}.third{grid-column:span 4}.hero{display:flex;justify-content:space-between;gap:18px;align-items:center}.avatar{width:76px;height:76px;border-radius:26px;background:linear-gradient(135deg,var(--accent),var(--hot));object-fit:cover}.muted{color:var(--muted)}.list{display:grid;gap:10px;max-height:560px;overflow:auto}.item{padding:13px;border:1px solid #ffffff12;border-radius:16px;background:#00000024}.row{display:flex;gap:10px;align-items:center;justify-content:space-between}.pill{font-size:12px;padding:4px 8px;border-radius:999px;background:#ffffff18;color:#d8d2e8}textarea,input,select{width:100%;border:1px solid #ffffff24;border-radius:14px;background:#05060bcc;color:var(--text);padding:11px}textarea{min-height:120px}.tabs{display:none}.tabs.active{display:block}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.danger{background:linear-gradient(135deg,#e11d48,#fb7185)}pre{white-space:pre-wrap;word-break:break-word;background:#02030a;border-radius:14px;padding:14px;max-height:480px;overflow:auto}@media(max-width:850px){.app{grid-template-columns:1fr}.side{position:relative;height:auto}.half,.third{grid-column:span 12}}
</style></head><body><div class="app"><aside class="side"><div class="brand">Keylime <span>Browser</span></div><p class="muted">Pi, but glossy. Localhost-first.</p><div class="nav"><button class="active" data-tab="chat">Chat Threads</button><button data-tab="memory">Memories & Events</button><button data-tab="tools">Tool Calls / Results</button><button data-tab="profile">Profile</button><button data-tab="theme">Theme</button></div><p id="health" class="muted"></p></aside><main>
<section id="chat" class="tabs active"><div class="grid"><div class="card hero"><div><h1>Chat Threads</h1><p class="muted">Inspect the current session and queue a follow-up into Pi.</p></div><button onclick="refreshThread()">Refresh</button></div><div class="card"><textarea id="chatBox" placeholder="Send a follow-up to Pi..."></textarea><div class="toolbar"><button onclick="sendChat()">Send to Pi</button></div><div id="thread" class="list"></div></div></div></section>
<section id="memory" class="tabs"><div class="grid"><div class="card hero"><div><h1>Memories & Events</h1><p class="muted">Browse, edit, add, and delete durable memories.</p></div><button onclick="loadMemories()">Refresh</button></div><div class="card half"><h2>Add memory</h2><input id="memContent" placeholder="Memory text"><div class="toolbar"><select id="memCategory"><option>preference</option><option>fact</option><option>event</option><option>goal</option><option>skill</option><option>context</option></select><input id="memTags" placeholder="tags, comma separated"></div><button onclick="addMemory()">Add</button></div><div class="card half"><h2>Key memory list</h2><div id="memories" class="list"></div></div></div></section>
<section id="tools" class="tabs"><div class="grid"><div class="card hero"><div><h1>Tool Calls / Results</h1><p class="muted">Manual inspection of compacted tool outputs.</p></div><button onclick="loadToolResults()">Refresh</button></div><div class="card third"><div id="toolResults" class="list"></div></div><div class="card" style="grid-column:span 8"><pre id="toolDetail">Select a tool result…</pre></div></div></section>
<section id="profile" class="tabs"><div class="grid"><div class="card hero"><div><h1>Profile Management</h1><p class="muted">Nickname, profile picture, and custom prompt instructions.</p></div><img id="avatar" class="avatar"></div><div class="card"><label>Nickname</label><input id="nickname"><label>Avatar data URL</label><input id="avatarDataUrl" placeholder="data:image/png;base64,..."><label>Custom instructions</label><textarea id="customInstructions"></textarea><label>Theme</label><select id="profileTheme"><option>aurora</option><option>graphite</option><option>rose</option><option>system</option></select><div class="toolbar"><button onclick="saveProfile()">Save profile</button><button class="ghost" onclick="loadProfile()">Reload</button></div></div></div></section>
<section id="theme" class="tabs"><div class="grid"><div class="card"><h1>Theme Studio</h1><p class="muted">Fast local theme switcher. Stored in profile.</p><div class="toolbar"><button onclick="setTheme('aurora')">Aurora</button><button onclick="setTheme('graphite')">Graphite</button><button onclick="setTheme('rose')">Rose</button></div></div></div></section>
</main></div><script>
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
async function api(p,o={}){const r=await fetch(p,{headers:{'content-type':'application/json',...(o.headers||{})},...o}); if(!r.ok) throw new Error(await r.text()); return r.headers.get('content-type')?.includes('json')?r.json():r.text()}
$$('.nav button').forEach(b=>b.onclick=()=>{$$('.nav button').forEach(x=>x.classList.remove('active'));$$('.tabs').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active')});
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function loadProfile(){const p=await api('/api/profile'); $('#nickname').value=p.nickname||''; $('#avatarDataUrl').value=p.avatarDataUrl||''; $('#customInstructions').value=p.customInstructions||''; $('#profileTheme').value=p.theme||'aurora'; $('#avatar').src=p.avatarDataUrl||''; setTheme(p.theme||'aurora')}
async function saveProfile(){await api('/api/profile',{method:'PUT',body:JSON.stringify({nickname:$('#nickname').value,avatarDataUrl:$('#avatarDataUrl').value,customInstructions:$('#customInstructions').value,theme:$('#profileTheme').value})}); await loadProfile()}
function setTheme(t){$('#profileTheme').value=t; const r=document.documentElement.style; if(t==='graphite'){r.setProperty('--accent','#64748b');r.setProperty('--hot','#e2e8f0')} else if(t==='rose'){r.setProperty('--accent','#e11d48');r.setProperty('--hot','#f9a8d4')} else {r.setProperty('--accent','#8b5cf6');r.setProperty('--hot','#22d3ee')}}
async function loadMemories(){const s=await api('/api/memories'); $('#memories').innerHTML=(s.memories||[]).map(m=>'<div class=item><div class=row><b>'+esc(m.category)+'</b><span class=pill>'+esc((m.tags||[]).join(', '))+'</span></div><p>'+esc(m.content)+'</p><div class=toolbar><button class=ghost onclick="editMem(\''+m.id+'\')">Edit</button><button class=danger onclick="delMem(\''+m.id+'\')">Delete</button></div></div>').join('')||'<p class=muted>No memories yet.</p>'}
async function addMemory(){await api('/api/memories',{method:'POST',body:JSON.stringify({content:$('#memContent').value,category:$('#memCategory').value,tags:$('#memTags').value.split(',').map(x=>x.trim()).filter(Boolean)})}); $('#memContent').value=''; await loadMemories()}
async function editMem(id){const content=prompt('Update memory content'); if(content) {await api('/api/memories/'+id,{method:'PATCH',body:JSON.stringify({content})}); await loadMemories()}}
async function delMem(id){if(confirm('Delete memory?')){await api('/api/memories/'+id,{method:'DELETE'}); await loadMemories()}}
async function loadToolResults(){const rs=await api('/api/tool-results'); $('#toolResults').innerHTML=(rs||[]).map(r=>'<div class=item onclick="showTool(\''+(r.id||r.result_id)+'\')"><b>'+esc(r.toolName||r.tool||'tool')+'</b><p class=muted>'+esc(r.createdAt||r.stored_at||'')+'</p></div>').join('')||'<p class=muted>No compacted tool results.</p>'}
async function showTool(id){$('#toolDetail').textContent=JSON.stringify(await api('/api/tool-results/'+id),null,2)}
async function refreshThread(){const t=await api('/api/thread'); $('#thread').innerHTML=(t.entries||[]).slice(-80).map(e=>'<div class=item><b>'+esc(e.type||e.role||'entry')+'</b><pre>'+esc(JSON.stringify(e,null,2))+'</pre></div>').join('')||'<p class=muted>No session entries exposed yet.</p>'}
async function sendChat(){await api('/api/chat',{method:'POST',body:JSON.stringify({message:$('#chatBox').value})}); $('#chatBox').value=''; await refreshThread()}
api('/api/health').then(h=>$('#health').textContent='Connected: '+h.cwd).catch(e=>$('#health').textContent='Disconnected'); loadProfile(); loadMemories(); loadToolResults(); refreshThread();
</script></body></html>`;
}

export default function webUiExtension(pi: ExtensionAPI) {
  pi.registerCommand("web-ui", {
    description: "Start the local Keylime browser UI",
    handler: async (args, ctx) => {
      const port = Number(args?.trim() || DEFAULT_PORT);
      const url = await startServer(pi, ctx, port);
      ctx.ui.notify(`Keylime browser UI: ${url}${process.env.KEYLIME_WEB_UI_TOKEN ? " (token required)" : ""}`, "info");
    },
  });
  pi.registerCommand("web-ui-stop", {
    description: "Stop the local Keylime browser UI",
    handler: async (_args, ctx) => { await stopServer(); ctx.ui.notify("Keylime browser UI stopped", "info"); },
  });
}
