import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleControlPlaneRequest } from "./routes";
import type { ControlPlaneState, RuntimeState } from "./types";

export const DEFAULT_CONTROL_PLANE_PORT = Number(process.env.KEYLIME_CONTROL_PLANE_PORT ?? 49714);

let server: Server | null = null;
let serverUrl = "";
export const runtimeState: RuntimeState = { agentState: "idle" };

export function createControlPlaneState(pi: ExtensionAPI, ctx: any, overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  return {
    cwd: ctx.cwd ?? process.cwd(),
    token: process.env.KEYLIME_CONTROL_PLANE_TOKEN,
    sendUserMessage: (text, options) => (pi as any).sendUserMessage?.(text, options),
    getEntries: () => ctx.sessionManager?.getEntries?.() ?? [],
    getCommands: () => (pi as any).getCommands?.() ?? [],
    runtime: runtimeState,
    ...overrides,
  };
}

export async function startControlPlaneServer(pi: ExtensionAPI, ctx: any, port = DEFAULT_CONTROL_PLANE_PORT, overrides: Partial<ControlPlaneState> = {}) {
  if (server) return serverUrl;
  const state = createControlPlaneState(pi, ctx, overrides);
  server = createServer(async (req, res) => sendResponse(res, await handleServerRequest(await nodeRequestToWeb(req), state)));
  await new Promise<void>(resolve => server!.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}/`;
  return serverUrl;
}

export async function stopControlPlaneServer() {
  if (!server) return;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  serverUrl = "";
}

async function handleServerRequest(request: Request, state: ControlPlaneState): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return handleControlPlaneRequest(request, state);
  return serveUiAsset(url, state.cwd);
}

async function serveUiAsset(url: URL, cwd: string): Promise<Response> {
  const rel = url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/ui/" ? "ui/keylime.dc.html" : decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!rel.startsWith("ui/")) return new Response("Not found", { status: 404 });
  const base = normalize(join(cwd, "ui"));
  const path = normalize(join(cwd, rel));
  if (!path.startsWith(base) || !existsSync(path)) return new Response("Not found", { status: 404 });
  const ext = path.split(".").pop()?.toLowerCase();
  const type = ext === "html" ? "text/html; charset=utf-8" : ext === "js" ? "text/javascript; charset=utf-8" : ext === "css" ? "text/css; charset=utf-8" : ext === "svg" ? "image/svg+xml" : "application/octet-stream";
  return new Response(await readFile(path), { headers: { "content-type": type, "cache-control": "no-cache" } });
}

async function nodeRequestToWeb(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method, headers: req.headers as any, body: chunks.length ? Buffer.concat(chunks) : undefined } as any);
}

async function sendResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
