import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type SignalPick = { key: string; value: string } | undefined;

export default function signalFooter(pi: ExtensionAPI) {
	let enabled = true;

	const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

	function totals(ctx: any) {
		let input = 0;
		let output = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage?.input ?? 0;
				output += m.usage?.output ?? 0;
			}
		}
		return { input, output };
	}

	function findSignal(statuses: ReadonlyMap<string, string>, aliases: string[]): SignalPick {
		const alias = aliases.map((a) => a.toLowerCase());
		for (const [key, value] of statuses.entries()) {
			const k = key.toLowerCase();
			const v = value.toLowerCase();
			if (alias.some((a) => k.includes(a) || v.includes(a))) {
				return { key, value };
			}
		}
		return undefined;
	}

	function apply(ctx: any) {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const statuses = footerData.getExtensionStatuses() as ReadonlyMap<string, string>;
					const memory = findSignal(statuses, ["memory", "mem"]);
					const ace = findSignal(statuses, ["ace"]);
					const cache = findSignal(statuses, ["cache", "cached", "hit-rate", "hit rate"]);

					const sigParts = [
						memory ? `mem:${memory.value}` : undefined,
						ace ? `ace:${ace.value}` : undefined,
						cache ? `cache:${cache.value}` : undefined,
					].filter(Boolean) as string[];

					const t = totals(ctx);
					const leftText = `${sigParts.length ? sigParts.join(" • ") : "signals:-"} • tok ↑${fmt(t.input)} ↓${fmt(t.output)}`;
					const rightText = `${ctx.model?.id || "no-model"}${footerData.getGitBranch() ? ` (${footerData.getGitBranch()})` : ""}`;

					const left = theme.fg("dim", leftText);
					const right = theme.fg("dim", rightText);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		apply(ctx);
	});

	pi.registerCommand("status-hud", {
		description: "Toggle compact high-signal global footer (mem/ace/cache/tokens)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(enabled ? "High-signal status HUD enabled" : "Default footer restored", "info");
		},
	});
}
