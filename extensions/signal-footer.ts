import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type SignalPick = { key: string; value: string } | undefined;

function plain(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function findSignal(statuses: ReadonlyMap<string, string>, aliases: string[]): SignalPick {
	const alias = aliases.map((value) => value.toLowerCase());
	for (const [key, value] of statuses.entries()) {
		const cleanKey = key.toLowerCase();
		const cleanValue = plain(value).toLowerCase();
		if (alias.some((candidate) => cleanKey.includes(candidate) || cleanValue.includes(candidate))) return { key, value };
	}
	return undefined;
}

function contextSummary(signal: SignalPick): string {
	if (!signal) return "ctx:—";
	const value = plain(signal.value).replace(/^(?:ctx|context)\s*:\s*/i, "");
	if (!value || value === "—" || value === "-") return "ctx:—";
	const pct = value.match(/(\d+(?:\.\d+)?)%/);
	const tokens = value.match(/([\d.]+[kmg]?)\s*\/\s*([\d.]+[kmg]?)/i);
	if (!pct) return `ctx:${value}`;
	return `ctx:${pct[1]}% pressure${tokens ? ` (${tokens[1]}/${tokens[2]})` : ""}`;
}

function cacheSummary(signal: SignalPick): string {
	if (!signal) return "cache:—";
	const value = plain(signal.value).replace(/^cache\s*:\s*/i, "");
	if (!value || value === "—" || value === "-") return "cache:—";
	const pct = value.match(/(\d+(?:\.\d+)?)%/);
	return pct ? `cache:${pct[1]}% reused` : `cache:${value}`;
}

export function buildSignalParts(statuses: ReadonlyMap<string, string>): string[] {
	const context = findSignal(statuses, ["context-health", "context", "ctx"]);
	const cache = findSignal(statuses, ["cache-guard", "cache", "cached", "hit-rate", "hit rate"]);
	const memory = findSignal(statuses, ["memory", "mem"]);
	const ace = findSignal(statuses, ["ace"]);
	return [
		contextSummary(context),
		cacheSummary(cache),
		memory ? `mem:${plain(memory.value).replace(/^mem(?:ory)?\s*:\s*/i, "")}` : undefined,
		ace ? `ace:${plain(ace.value).replace(/^ace\s*:\s*/i, "")}` : undefined,
	].filter(Boolean) as string[];
}

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
					const sigParts = buildSignalParts(statuses);

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
		description: "Toggle compact high-signal global footer (context pressure/cache reuse/memory/tokens)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(enabled ? "High-signal status HUD enabled" : "Default footer restored", "info");
		},
	});
}
