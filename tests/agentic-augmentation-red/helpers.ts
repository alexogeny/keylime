import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function productionModule(name: string): Promise<any> {
  return import(new URL(`../../extensions/shared/${name}.ts`, import.meta.url).href);
}

export async function fixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `keylime-agentic-${prefix}-`));
}

export async function writeFixture(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function createPiRecorder() {
  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const statuses = new Map<string, string>();
  const notifications: Array<{ text: string; level?: string }> = [];
  const pi: any = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool() {},
    appendEntry(customType: string, data: any) {
      const entry = { id: `entry-${entries.length + 1}`, type: "custom", customType, data };
      entries.push(entry);
      return entry;
    },
    getAllTools() { return []; },
    getActiveTools() { return []; },
    getCommands() { return [...commands.entries()].map(([name, command]) => ({ name, ...command })); },
  };
  const ctx: any = {
    cwd: process.cwd(),
    model: { provider: "test", id: "test-model" },
    getContextUsage: () => ({ percent: 20, tokens: 2_000, contextWindow: 10_000 }),
    sessionManager: { getEntries: () => entries },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (key: string, value: string) => statuses.set(key, value),
      notify: (text: string, level?: string) => notifications.push({ text, level }),
    },
  };
  return {
    pi, ctx, hooks, commands, entries, statuses, notifications,
    async emit(name: string, event: any = {}) {
      const results = [];
      for (const handler of hooks.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}
