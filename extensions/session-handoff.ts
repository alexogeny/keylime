import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildHandoffCommandPlan, planSessionBootstrapInjection } from "./shared/session-handoff";

export default function sessionHandoffExtension(pi: ExtensionAPI) {
  const consumed = new Set<string>();

  pi.registerCommand("handoff", {
    description: "Persist a bounded project checkpoint for a fresh session",
    handler: async (args, ctx) => {
      const goal = String(args ?? "").trim() || "Continue the current repository task";
      const sessionId = String(ctx.sessionManager?.getSessionId?.() ?? "session");
      const plan = buildHandoffCommandPlan({ goal, pendingActions: [goal], sessionId });
      const entry = plan.entries[0];
      pi.appendEntry("token-efficiency-handoff", { ...(entry.data as Record<string, unknown>), bootstrap: plan.bootstrap });
      if (typeof ctx.newSession === "function") {
        await ctx.waitForIdle?.();
        const result = await ctx.newSession({
          parentSession: ctx.sessionManager?.getSessionFile?.(),
          setup: async (sessionManager: any) => {
            sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: plan.bootstrap }], timestamp: Date.now() });
          },
        });
        if (result?.cancelled) ctx.ui?.notify?.("Handoff checkpoint saved, but session replacement was cancelled.", "warning");
        return;
      }
      ctx.ui?.notify?.("Handoff checkpoint saved. Start a fresh session to consume the bounded bootstrap.", "info");
    },
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    const entries = Array.isArray(event?.entries) ? event.entries : ctx.sessionManager?.getEntries?.() ?? [];
    const checkpointEntry = [...entries].reverse().find((entry: any) =>
      (entry?.type === "custom" && entry?.customType === "token-efficiency-handoff")
      || entry?.type === "token-efficiency-handoff"
    );
    const checkpoint = checkpointEntry?.data;
    if (!checkpoint?.id) return;
    const plan = planSessionBootstrapInjection({
      destinationSessionId: String(ctx.sessionManager?.getSessionId?.() ?? "session"),
      consumedCheckpointIds: [...consumed],
      checkpoint,
    });
    if (!plan.inject) return;
    consumed.add(plan.markConsumed!);
    pi.sendUserMessage(String(checkpoint.bootstrap ?? plan.bootstrap), { deliverAs: "followUp" });
  });
}
