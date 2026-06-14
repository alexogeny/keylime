import type { ApiEnvelope, ApiError, ApiMeta } from "./types";

export function meta(capabilities?: string[]): ApiMeta {
  return { requestId: crypto.randomUUID(), generatedAt: Date.now(), backend: "pi", capabilities };
}

export function ok<T>(data: T, capabilities?: string[], status = 200): Response {
  const body: ApiEnvelope<T> = { ok: true, data, meta: meta(capabilities) };
  return jsonResponse(body, status);
}

export function fail(code: string, message: string, status = 500, detail?: unknown): Response {
  const error: ApiError = { code, message, detail };
  const body: ApiEnvelope<never> = { ok: false, error, meta: meta() };
  return jsonResponse(body, status);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function parseJson<T = any>(request: Request): Promise<T> {
  const text = await request.text();
  return text.trim() ? JSON.parse(text) as T : {} as T;
}
