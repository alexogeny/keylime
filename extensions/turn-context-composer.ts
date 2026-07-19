import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { composeTurnContext, listContextProviders } from "./shared/turn-context";
import { buildContextLedgerRecord, setPendingContextLedgerRecord } from "./shared/context-ledger";

const STATUS_KEY = "turnctx";

export default function turnContextComposerExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `ctxp:${listContextProviders().length}`));
  });

  pi.on("context", async (event, ctx) => {
    const result = await composeTurnContext(ctx, event.messages as any[]);
    const providerChars = result.diagnostics.providers
      .filter(provider => provider.included)
      .reduce((total, provider) => total + provider.finalChars, 0);
    const activeToolNames = pi.getActiveTools().map((tool: any) => typeof tool === "string" ? tool : tool?.name).filter(Boolean);
    setPendingContextLedgerRecord(buildContextLedgerRecord({
      ts: Date.now(),
      activeToolNames,
      parts: providerChars > 0 ? [{ category: "turn_provider", text: "x".repeat(providerChars) }] : [],
      transforms: [],
    }));
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `ctxp:${result.providerIds.length}`));
    return { messages: result.messages };
  });

  pi.registerCommand("context-providers", {
    description: "List registered turn-context providers",
    handler: async (_args, ctx) => {
      const providers = listContextProviders();
      ctx.ui.notify(
        providers.length
          ? providers.map(p => `${p.id} priority=${p.priority} max=${p.maxChars}`).join("\n")
          : "No context providers registered.",
        "info",
      );
    },
  });
}
