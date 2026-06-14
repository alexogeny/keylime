import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONTROL_PLANE_PORT, runtimeState, startControlPlaneServer, stopControlPlaneServer } from "./server";
import { normalizeModel } from "./normalizers";

export * from "./types";
export * from "./routes";
export * from "./server";
export * from "./normalizers";

export default function controlPlaneApiExtension(pi: ExtensionAPI) {
  (pi as any).on?.("model_select", (event: any) => {
    runtimeState.model = normalizeModel(event.model);
    runtimeState.previousModel = normalizeModel(event.previousModel);
    runtimeState.source = event.source;
    runtimeState.updatedAt = Date.now();
  });
  (pi as any).on?.("thinking_level_select", (event: any) => {
    runtimeState.thinkingLevel = event.thinkingLevel ?? event.level ?? event;
    runtimeState.updatedAt = Date.now();
  });
  (pi as any).on?.("turn_start", () => { runtimeState.agentState = "thinking"; runtimeState.updatedAt = Date.now(); });
  (pi as any).on?.("turn_end", () => { runtimeState.agentState = "done"; runtimeState.updatedAt = Date.now(); });
  (pi as any).on?.("tool_call", () => { runtimeState.agentState = "calling_tools"; runtimeState.updatedAt = Date.now(); });
  pi.registerCommand("keylime", { description: "Start the local Keylime control plane API and graphite UI", handler: async (args, ctx) => { const port = Number(args?.trim() || DEFAULT_CONTROL_PLANE_PORT); const url = await startControlPlaneServer(pi, ctx, port); ctx.ui.notify(`Keylime control plane: ${url}ui/keylime.dc.html`, "info"); } });
  pi.registerCommand("keylime-stop", { description: "Stop the local Keylime control plane API and graphite UI", handler: async (_args, ctx) => { await stopControlPlaneServer(); ctx.ui.notify("Keylime control plane stopped", "info"); } });
}
