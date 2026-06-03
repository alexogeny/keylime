import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentRoute, stripSystemReminders, type IntentRoute } from "./intent";

export type ContextProviderArgs = {
  ctx: ExtensionContext;
  messages: any[];
  prompt: string;
  route: IntentRoute;
  pressure: "low" | "medium" | "high";
};

export type ContextProvider = {
  id: string;
  priority: number;
  maxChars: number;
  applies?: (args: ContextProviderArgs) => boolean | Promise<boolean>;
  build: (args: ContextProviderArgs) => string | null | undefined | Promise<string | null | undefined>;
};

const providers = new Map<string, ContextProvider>();

export function registerContextProvider(provider: ContextProvider): void {
  providers.set(provider.id, provider);
}

export function clearContextProviders(): void {
  providers.clear();
}

export function listContextProviders(): ContextProvider[] {
  return [...providers.values()].sort((a, b) => b.priority - a.priority);
}

export function promptFromMessages(messages: any[]): string {
  const msg = [...messages].reverse().find((m: any) => m?.role === "user");
  if (!msg) return "";
  if (typeof msg.content === "string") return stripSystemReminders(msg.content);
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text as string)
    .join("\n");
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
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n… [trimmed]`;
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

export async function composeTurnContext(ctx: ExtensionContext, messages: any[]): Promise<{ messages: any[]; providerIds: string[] }> {
  const pressure = contextPressure(ctx);
  const route = getCurrentRoute();
  const prompt = promptFromMessages(messages);
  const args: ContextProviderArgs = { ctx, messages, prompt, route, pressure };
  const sections: string[] = [];
  const providerIds: string[] = [];
  let remaining = totalBudget(pressure);

  for (const provider of listContextProviders()) {
    if (remaining <= 80) break;
    if (provider.applies && !(await provider.applies(args))) continue;

    const raw = await provider.build(args);
    if (!raw?.trim()) continue;

    const budget = Math.min(provider.maxChars, remaining);
    const text = trimTo(raw.trim(), budget);
    sections.push(text);
    providerIds.push(provider.id);
    remaining -= text.length + 2;
  }

  if (sections.length === 0) return { messages, providerIds };
  return { messages: appendReminder(messages, sections.join("\n\n")), providerIds };
}
