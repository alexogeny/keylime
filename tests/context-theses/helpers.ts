import { expect } from "bun:test";

export type UnknownApi = Record<string, unknown>;

export async function loadThesisModule(moduleName: string): Promise<UnknownApi> {
  try {
    const path = `../../../extensions/shared/${moduleName}.ts`;
    return await import(path) as UnknownApi;
  } catch (error) {
    if ((error as Error).message.includes("Cannot find module")) return {};
    throw error;
  }
}

export function thesisFunction<T extends (...args: any[]) => any>(api: UnknownApi, name: string): T {
  expect(api[name], `RED thesis API missing: ${name}`).toBeFunction();
  return api[name] as T;
}

export function chars(value: unknown): number {
  return JSON.stringify(value).length;
}
