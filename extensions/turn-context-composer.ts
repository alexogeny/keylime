import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { composeTurnContext, listContextProviders } from "./shared/turn-context";

const STATUS_KEY = "turnctx";

export default function turnContextComposerExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `ctxp:${listContextProviders().length}`));
  });

  pi.on("context", async (event, ctx) => {
    const result = await composeTurnContext(ctx, event.messages as any[]);
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
