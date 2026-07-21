import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentRoute, type IntentRoute } from "./intent";
import { promptFromMessages, textFromContent } from "./message-content";
import { truncateWithMarker } from "./output-preview";
import { contextFingerprint } from "./context-ledger";
import { allocateContextBudget } from "./context-value-allocator";

export type ContextProviderArgs = {
  ctx: ExtensionContext;
  messages: any[];
  prompt: string;
  route: IntentRoute;
  pressure: "low" | "medium" | "high";
  remainingBudget: number;
};

export type ContextProviderStability = "static" | "session" | "turn";

export type ContextProvider = {
  id: string;
  priority: number;
  maxChars: number;
  stability?: ContextProviderStability;
  applies?: (args: ContextProviderArgs) => boolean | Promise<boolean>;
  dependencyFingerprint?: (args: ContextProviderArgs) => string | Promise<string>;
  build: (args: ContextProviderArgs) => string | null | undefined | Promise<string | null | undefined>;
};

export type ContextProviderDiagnostic = {
  id: string;
  priority: number;
  stability: ContextProviderStability;
  budget: number;
  rawChars: number;
  finalChars: number;
  trimmed: boolean;
  included: boolean;
  fingerprint?: string;
  skippedReason?: "not_applicable" | "empty" | "duplicate" | "budget" | "utility_budget";
};

export type TurnContextDiagnostics = {
  pressure: "low" | "medium" | "high";
  totalBudget: number;
  providers: ContextProviderDiagnostic[];
};

const providers = new Map<string, ContextProvider>();
const stableProviderCache = new Map<string, { dependency: string; value: string | null | undefined }>();
const turnProviderCache = new Map<string, { turnKey: string; value: string | null | undefined }>();

export function registerContextProvider(provider: ContextProvider): void {
  providers.set(provider.id, provider);
  stableProviderCache.delete(provider.id);
  turnProviderCache.delete(provider.id);
}

export function clearContextProviders(): void {
  providers.clear();
  stableProviderCache.clear();
  turnProviderCache.clear();
}

export function clearTurnContextCache(): void {
  turnProviderCache.clear();
}

function stabilityRank(stability: ContextProviderStability | undefined): number {
  if (stability === "static") return 0;
  if (stability === "session") return 1;
  return 2;
}

export function listContextProviders(): ContextProvider[] {
  return [...providers.values()].sort((a, b) =>
    b.priority - a.priority
    || stabilityRank(a.stability) - stabilityRank(b.stability)
    || a.id.localeCompare(b.id)
  );
}

function contextPressure(ctx: ExtensionContext): "low" | "medium" | "high" {
  const usage = (ctx as any).getContextUsage?.();
  const percent = usage?.percent ?? (usage?.tokens && usage?.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : 0);
  if (percent >= 85) return "high";
  if (percent >= 65) return "medium";
  return "low";
}

function totalBudget(pressure: "low" | "medium" | "high"): number {
  if (pressure === "high") return 900;
  if (pressure === "medium") return 1_300;
  return 1_800;
}

function trimTo(text: string, maxChars: number): string {
  return truncateWithMarker(text, maxChars, "… [trimmed]");
}

function appendReminder(messages: any[], text: string): any[] {
  const result = [...messages];
  const suffix = `\n\n<system-reminder>\n${text}\n</system-reminder>`;
  const lastIndex = result.length - 1;
  const last = result[lastIndex];

  // Only rewrite the newest user message. Once assistant/tool traffic follows it,
  // changing that old message destroys the provider's cached history prefix.
  if (last?.role === "user") {
    if (typeof last.content === "string") {
      result[lastIndex] = { ...last, content: last.content + suffix };
      return result;
    }
    if (Array.isArray(last.content)) {
      const blocks = [...last.content];
      const lastText = blocks.findLastIndex((block: any) => block?.type === "text");
      if (lastText >= 0) blocks[lastText] = { ...blocks[lastText], text: `${blocks[lastText].text}${suffix}` };
      else blocks.push({ type: "text", text: suffix.trimStart() });
      result[lastIndex] = { ...last, content: blocks };
      return result;
    }
  }

  // Tool loops must keep all existing messages byte-stable. Put volatile context
  // in a new tail message instead of editing the user request behind the loop.
  result.push({ role: "user", content: `<system-reminder>\n${text}\n</system-reminder>` });
  return result;
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function logicalTurnKey(messages: any[]): string {
  let userCount = 0;
  let latestUser = "";
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content);
    if (!text.trim()) continue;
    userCount++;
    latestUser = text;
  }
  return `${userCount}:${latestUser}`;
}

export async function composeTurnContext(ctx: ExtensionContext, messages: any[]): Promise<{ messages: any[]; providerIds: string[]; diagnostics: TurnContextDiagnostics }> {
  const pressure = contextPressure(ctx);
  const route = getCurrentRoute();
  const prompt = promptFromMessages(messages);
  const baseArgs = { ctx, messages, prompt, route, pressure };
  const turnKey = logicalTurnKey(messages);
  const sections: string[] = [];
  const providerIds: string[] = [];
  const diagnostics: ContextProviderDiagnostic[] = [];
  const seen = new Set<string>();
  const fullBudget = totalBudget(pressure);
  let remaining = fullBudget;
  let refillBudget = 0;
  const providers = listContextProviders();
  const baseShare = Math.max(80, Math.floor(fullBudget / Math.max(1, providers.length)));
  const providerAllocation = allocateContextBudget(providers.map(provider => ({
    id: provider.id,
    category: provider.stability ?? "turn",
    chars: Math.min(provider.maxChars, Math.max(80, Math.round(baseShare * (.5 + provider.priority / 100)))),
    relevance: Math.max(0, Math.min(1, provider.priority / 100)),
    impact: provider.priority >= 90 ? 1 : .6,
    freshness: provider.stability === "turn" || !provider.stability ? 1 : .7,
    confidence: .9,
    lossRisk: provider.priority >= 90 ? 1 : .5,
    recoverable: provider.stability === "static",
    mandatory: provider.priority >= 90,
  })), { maxChars: fullBudget });
  const plannedBudgets = new Map(providerAllocation.selected.map(item => [item.id, item.chars]));

  for (const provider of providers) {
    const stability = provider.stability ?? "turn";
    const plannedBudget = plannedBudgets.get(provider.id);
    if (!plannedBudget && refillBudget <= 80) {
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: 0, finalChars: 0, trimmed: false, included: false, skippedReason: "utility_budget" });
      continue;
    }
    if (remaining <= 80) {
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: 0, finalChars: 0, trimmed: false, included: false, skippedReason: "budget" });
      break;
    }
    const args: ContextProviderArgs = { ...baseArgs, remainingBudget: remaining };
    if (provider.applies && !(await provider.applies(args))) {
      if (plannedBudget) refillBudget += plannedBudget;
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: 0, finalChars: 0, trimmed: false, included: false, skippedReason: "not_applicable" });
      continue;
    }

    let raw: string | null | undefined;
    if (stability === "turn") {
      const cached = turnProviderCache.get(provider.id);
      if (cached?.turnKey === turnKey) raw = cached.value;
      else {
        raw = await provider.build(args);
        turnProviderCache.set(provider.id, { turnKey, value: raw });
      }
    } else if (provider.dependencyFingerprint) {
      const dependency = await provider.dependencyFingerprint(args);
      const cached = stableProviderCache.get(provider.id);
      if (cached?.dependency === dependency) raw = cached.value;
      else {
        raw = await provider.build(args);
        stableProviderCache.set(provider.id, { dependency, value: raw });
      }
    } else {
      raw = await provider.build(args);
    }
    if (!raw?.trim()) {
      if (plannedBudget) refillBudget += plannedBudget;
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: raw?.length ?? 0, finalChars: 0, trimmed: false, included: false, skippedReason: "empty" });
      continue;
    }

    const normalized = normalizeForDedupe(raw);
    if (seen.has(normalized)) {
      if (plannedBudget) refillBudget += plannedBudget;
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: raw.trim().length, finalChars: 0, trimmed: false, included: false, skippedReason: "duplicate" });
      continue;
    }
    seen.add(normalized);

    const budget = Math.min(provider.maxChars, remaining, plannedBudget ? remaining : refillBudget);
    const text = trimTo(raw.trim(), budget);
    const trimmed = text !== raw.trim();
    sections.push(text);
    providerIds.push(provider.id);
    diagnostics.push({
      id: provider.id,
      priority: provider.priority,
      stability,
      budget,
      rawChars: raw.trim().length,
      finalChars: text.length,
      trimmed,
      included: true,
      fingerprint: contextFingerprint([text]),
    });
    remaining -= text.length + 2;
    if (!plannedBudget) refillBudget = Math.max(0, refillBudget - text.length - 2);
  }

  const resultDiagnostics = { pressure, totalBudget: fullBudget, providers: diagnostics };
  if (sections.length === 0) return { messages, providerIds, diagnostics: resultDiagnostics };
  return { messages: appendReminder(messages, sections.join("\n\n")), providerIds, diagnostics: resultDiagnostics };
}
