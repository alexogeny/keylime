import { knownToolNames } from "../../extensions/shared/tool-policy";

export function allKnownTestTools(extraTools: string[] = []): string[] {
  return [...new Set([...knownToolNames(), "custom_safe_tool", ...extraTools])].sort();
}

export function mockPiFixture(options: { active?: string[]; extraTools?: string[] } = {}) {
  let activeTools = options.active ?? ["code_search"];
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const handlers: Record<string, any[]> = {};
  const notifications: string[] = [];
  const status: Record<string, string> = {};
  const allTools = allKnownTestTools(options.extraTools);

  return {
    pi: {
      getAllTools: () => [...new Set([...allTools, ...Object.keys(tools)])].sort().map(name => ({ name })),
      getActiveTools: () => activeTools.map(name => ({ name })),
      setActiveTools: (names: string[]) => { activeTools = names; },
      on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      appendEntry: () => {},
      registerShortcut: () => {},
    } as any,
    tools,
    commands,
    handlers,
    notifications,
    status,
    ctx: {
      ui: {
        setStatus: (key: string, value: string) => { status[key] = value; },
        notify: (text: string) => { notifications.push(text); },
        theme: { fg: (_style: string, text: string) => text },
      },
    } as any,
    get activeTools() { return activeTools; },
  };
}

export function mockPi(active: string[] = ["code_search"], extraTools: string[] = []) {
  return mockPiFixture({ active, extraTools }).pi;
}
