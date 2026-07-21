import { createHash } from "node:crypto";

type PromptTool = { name: string; description?: string; schema?: unknown };
type PromptMessage = { role?: string; content?: unknown };
export type PromptPayload = {
  systemPrompt?: string;
  tools?: PromptTool[];
  messages?: PromptMessage[];
  stableMessageCount?: number;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function serialize(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stablePrefix(payload: PromptPayload) {
  const messages = payload.messages ?? [];
  const stableMessageCount = Math.max(0, Math.min(payload.stableMessageCount ?? messages.length, messages.length));
  return {
    systemPrompt: payload.systemPrompt ?? "",
    tools: payload.tools ?? [],
    messages: messages.slice(0, stableMessageCount),
  };
}

export function fingerprintPromptPrefix(payload: PromptPayload): { hash: string; prefixChars: number } {
  const text = serialize(stablePrefix(payload));
  return { hash: createHash("sha256").update(text).digest("hex"), prefixChars: text.length };
}

export function profilePromptPayload(payload: PromptPayload) {
  const messages = payload.messages ?? [];
  const stableMessageCount = Math.max(0, Math.min(payload.stableMessageCount ?? messages.length, messages.length));
  const categories = {
    system: { chars: serialize(payload.systemPrompt ?? "").length },
    tools: { chars: serialize(payload.tools ?? []).length },
    stableHistory: { chars: serialize(messages.slice(0, stableMessageCount)).length },
    volatileSuffix: { chars: serialize(messages.slice(stableMessageCount)).length },
  };
  return {
    categories,
    totalChars: Object.values(categories).reduce((sum, category) => sum + category.chars, 0),
    prefix: fingerprintPromptPrefix(payload),
  };
}

export function diffPromptPrefixes(previous: PromptPayload, current: PromptPayload) {
  const changedCategories: string[] = [];
  let firstChangedPath = "";
  if (previous.systemPrompt !== current.systemPrompt) {
    changedCategories.push("system");
    firstChangedPath ||= "systemPrompt";
  }
  const previousTools = previous.tools ?? [];
  const currentTools = current.tools ?? [];
  const previousNames = previousTools.map(tool => tool.name);
  const currentNames = currentTools.map(tool => tool.name);
  const addedTools = currentNames.filter(name => !previousNames.includes(name));
  const removedTools = previousNames.filter(name => !currentNames.includes(name));
  if (addedTools.length > 0 || removedTools.length > 0) {
    changedCategories.push("tool_set");
    firstChangedPath ||= "tools";
  } else if (previousNames.some((name, index) => currentNames[index] !== name)) {
    changedCategories.push("tool_order");
    firstChangedPath ||= "tools[0]";
  }
  for (const previousTool of previousTools) {
    const currentTool = currentTools.find(tool => tool.name === previousTool.name);
    if (currentTool && serialize(previousTool) !== serialize(currentTool)) {
      if (!changedCategories.includes("tool_schema")) changedCategories.push("tool_schema");
      firstChangedPath ||= `tools.${previousTool.name}`;
    }
  }
  const previousStable = stablePrefix(previous).messages;
  const currentStable = stablePrefix(current).messages;
  if (serialize(previousStable) !== serialize(currentStable)) {
    changedCategories.push("stable_history");
    firstChangedPath ||= "messages";
  }
  const previousHash = fingerprintPromptPrefix(previous).hash;
  const currentHash = fingerprintPromptPrefix(current).hash;
  return { cacheBust: previousHash !== currentHash, changedCategories, firstChangedPath, addedTools, removedTools, previousHash, currentHash };
}

export function compareToolExposureStrategies<T extends {
  strategy: string;
  taskSucceeded: boolean;
  costUsd: number;
  extraCalls?: number;
}>(samples: T[]) {
  const successful = samples.filter(sample => sample.taskSucceeded);
  const ranked = [...successful].sort((left, right) => left.costUsd - right.costUsd || (left.extraCalls ?? 0) - (right.extraCalls ?? 0) || left.strategy.localeCompare(right.strategy));
  return {
    best: ranked.length > 0 ? { ...ranked[0], reason: "lowest successful-task cost among successful strategies" } : null,
    ranked,
  };
}

function providerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(providerText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return providerText(record.content);
  }
  return value == null ? "" : serialize(value);
}

export function adaptProviderPayloadForProfiling(payload: Record<string, unknown>): PromptPayload {
  const rawTools = Array.isArray(payload.tools) ? payload.tools : [];
  const tools: PromptTool[] = rawTools.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const outer = raw as Record<string, unknown>;
    const nested = outer.function && typeof outer.function === "object" ? outer.function as Record<string, unknown> : outer;
    const name = typeof nested.name === "string" ? nested.name : typeof outer.name === "string" ? outer.name : undefined;
    if (!name) return [];
    return [{
      name,
      description: typeof nested.description === "string" ? nested.description : undefined,
      schema: nested.input_schema ?? nested.parameters ?? outer.input_schema ?? outer.parameters,
    }];
  });
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.input) ? payload.input : [];
  const messages: PromptMessage[] = rawMessages.map(raw => {
    if (!raw || typeof raw !== "object") return { content: providerText(raw) };
    const record = raw as Record<string, unknown>;
    return { role: typeof record.role === "string" ? record.role : undefined, content: providerText(record.content ?? record) };
  });
  return {
    systemPrompt: providerText(payload.system ?? payload.instructions ?? ""),
    tools,
    messages,
    stableMessageCount: Math.max(0, messages.length - 1),
  };
}

type SafePrefixComponents = {
  systemHash: string;
  toolSetHash: string;
  toolOrderHash: string;
  toolSchemaHash: string;
  stableHistoryHash: string;
};

export type PromptPrefixDiagnostic = {
  current: { hash: string; prefixChars: number };
  profile: ReturnType<typeof profilePromptPayload> extends infer P
    ? P extends { categories: infer C; totalChars: infer T } ? { categories: C; totalChars: T } : never
    : never;
  components: SafePrefixComponents;
  diff?: { cacheBust: boolean; changedCategories: string[]; firstChangedPath: string };
};

function valueHash(value: unknown): string {
  return createHash("sha256").update(serialize(value)).digest("hex");
}

function safeComponents(payload: PromptPayload): SafePrefixComponents {
  const tools = payload.tools ?? [];
  const stable = stablePrefix(payload);
  return {
    systemHash: valueHash(payload.systemPrompt ?? ""),
    toolSetHash: valueHash(tools.map(tool => tool.name).sort()),
    toolOrderHash: valueHash(tools.map(tool => tool.name)),
    toolSchemaHash: valueHash([...tools].sort((left, right) => left.name.localeCompare(right.name))),
    stableHistoryHash: valueHash(stable.messages),
  };
}

export function buildPromptPrefixDiagnostic(previous: PromptPrefixDiagnostic | undefined, currentPayload: Record<string, unknown>): PromptPrefixDiagnostic {
  const currentAdapted = adaptProviderPayloadForProfiling(currentPayload);
  const profile = profilePromptPayload(currentAdapted);
  const components = safeComponents(currentAdapted);
  const changedCategories: string[] = [];
  let firstChangedPath = "";
  if (previous) {
    if (previous.components.systemHash !== components.systemHash) { changedCategories.push("system"); firstChangedPath ||= "systemPrompt"; }
    if (previous.components.toolSetHash !== components.toolSetHash) { changedCategories.push("tool_set"); firstChangedPath ||= "tools"; }
    else if (previous.components.toolOrderHash !== components.toolOrderHash) { changedCategories.push("tool_order"); firstChangedPath ||= "tools[0]"; }
    if (previous.components.toolSchemaHash !== components.toolSchemaHash) { changedCategories.push("tool_schema"); firstChangedPath ||= "tools"; }
    if (previous.components.stableHistoryHash !== components.stableHistoryHash) { changedCategories.push("stable_history"); firstChangedPath ||= "messages"; }
  }
  return {
    current: profile.prefix,
    profile: { categories: profile.categories, totalChars: profile.totalChars },
    components,
    diff: previous ? { cacheBust: previous.current.hash !== profile.prefix.hash, changedCategories, firstChangedPath } : undefined,
  };
}
