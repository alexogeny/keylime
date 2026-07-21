import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export default function thinkingLevelCommandExtension(pi: ExtensionAPI) {
  pi.registerCommand("thinking-level", {
    description: "Select the model thinking/reasoning level",
    handler: async (args, ctx) => {
      const requested = String(args ?? "").trim().toLowerCase();
      let selected: ThinkingLevel | undefined;
      if (requested) {
        if (!isThinkingLevel(requested)) {
          ctx.ui.notify(`Unknown thinking level: ${requested}\nChoose one of: ${THINKING_LEVELS.join(", ")}`, "warning");
          return;
        }
        selected = requested;
      } else {
        const current = String(pi.getThinkingLevel?.() ?? "off");
        const choice = await ctx.ui.select(`Thinking level · Current: ${current}`, [...THINKING_LEVELS]);
        if (!choice) return;
        selected = choice as ThinkingLevel;
      }

      pi.setThinkingLevel(selected);
      const applied = String(pi.getThinkingLevel?.() ?? selected);
      ctx.ui.notify(applied === selected
        ? `Thinking level set to ${applied}.`
        : `Thinking level requested: ${selected}; model applied ${applied}.`, "info");
    },
  });
}
