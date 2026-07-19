import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentRoute, type IntentRoute } from "./intent";
import { promptFromMessages } from "./message-content";
import { truncateWithMarker } from "./output-preview";
import { contextFingerprint } from "./context-ledger";

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
  skippedReason?: "not_applicable" | "empty" | "duplicate" | "budget";
};

export type TurnContextDiagnostics = {
  pressure: "low" | "medium" | "high";
  totalBudget: number;
  providers: ContextProviderDiagnostic[];
};

const providers = new Map<string, ContextProvider>();
const stableProviderCache = new Map<string, { dependency: string; value: string | null | undefined }>();

export function registerContextProvider(provider: ContextProvider): void {
  providers.set(provider.id, provider);
  stableProviderCache.delete(provider.id);
}

export function clearContextProviders(): void {
  providers.clear();
  stableProviderCache.clear();
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
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]?.role !== "user") continue;
    const suffix = `\n\n<system-reminder>\n${text}\n</system-reminder>`;
    const msg = result[i];
    if (typeof msg.content === "string") {
      result[i] = { ...msg, content: msg.content + suffix };
      return result;
    }
    if (Array.isArray(msg.content)) {
      const blocks = [...msg.content];
      const lastText = blocks.findLastIndex((block: any) => block?.type === "text");
      if (lastText >= 0) {
        blocks[lastText] = { ...blocks[lastText], text: `${blocks[lastText].text}${suffix}` };
      } else {
        blocks.push({ type: "text", text: suffix });
      }
      result[i] = { ...msg, content: blocks };
      return result;
    }
  }
  return result;
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function composeTurnContext(ctx: ExtensionContext, messages: any[]): Promise<{ messages: any[]; providerIds: string[]; diagnostics: TurnContextDiagnostics }> {
  const pressure = contextPressure(ctx);
  const route = getCurrentRoute();
  const prompt = promptFromMessages(messages);
  const baseArgs = { ctx, messages, prompt, route, pressure };
  const sections: string[] = [];
  const providerIds: string[] = [];
  const diagnostics: ContextProviderDiagnostic[] = [];
  const seen = new Set<string>();
  const fullBudget = totalBudget(pressure);
  let remaining = fullBudget;

  for (const provider of listContextProviders()) {
    const stability = provider.stability ?? "turn";
    if (remaining <= 80) {
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: 0, finalChars: 0, trimmed: false, included: false, skippedReason: "budget" });
      break;
    }
    const args: ContextProviderArgs = { ...baseArgs, remainingBudget: remaining };
    if (provider.applies && !(await provider.applies(args))) {
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: 0, finalChars: 0, trimmed: false, included: false, skippedReason: "not_applicable" });
      continue;
    }

    let raw: string | null | undefined;
    if (stability !== "turn" && provider.dependencyFingerprint) {
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
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: raw?.length ?? 0, finalChars: 0, trimmed: false, included: false, skippedReason: "empty" });
      continue;
    }

    const normalized = normalizeForDedupe(raw);
    if (seen.has(normalized)) {
      diagnostics.push({ id: provider.id, priority: provider.priority, stability, budget: 0, rawChars: raw.trim().length, finalChars: 0, trimmed: false, included: false, skippedReason: "duplicate" });
      continue;
    }
    seen.add(normalized);

    const budget = Math.min(provider.maxChars, remaining);
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
  }

  const resultDiagnostics = { pressure, totalBudget: fullBudget, providers: diagnostics };
  if (sections.length === 0) return { messages, providerIds, diagnostics: resultDiagnostics };
  return { messages: appendReminder(messages, sections.join("\n\n")), providerIds, diagnostics: resultDiagnostics };
}
