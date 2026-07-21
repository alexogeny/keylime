import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { IntentId } from "./shared/intent";

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

export const INTENT_PERSONAS: Record<IntentId, string> = {
	chat: "Companion",
	coding: "Builder",
	debugging: "Mechanic",
	refactor: "Gardener",
	review: "Sentinel",
	planning: "Architect",
	project: "Foreman",
	research: "Scout",
	memory: "Archivist",
	personal: "Concierge",
	running_shoes: "Outfitter",
	running_biomechanics: "Coach",
	python_engineering: "Pythonista",
	rust_systems: "Smith",
	rust_shell_emulator: "Shellsmith",
	linux_ops: "Operator",
	profiling: "Tuner",
	ui_design: "Designer",
};

const PERSONA_ALIASES: Record<string, IntentId> = {
	programming: "coding", code: "coding", debug: "debugging", plan: "planning", repo: "project",
	web: "research", fetch: "research", shoes: "running_shoes", biomechanics: "running_biomechanics",
	python: "python_engineering", rust: "rust_systems", shell: "rust_shell_emulator", linux: "linux_ops", ui: "ui_design",
};

export function memoryPersona(raw: string): string {
	const value = plain(raw).replace(/^mem(?:ory)?\s*:\s*/i, "").toLowerCase();
	const route = value.split(":", 1)[0].trim().replace(/-/g, "_");
	const normalized = PERSONA_ALIASES[route] ?? route;
	if (normalized in INTENT_PERSONAS) return INTENT_PERSONAS[normalized as IntentId];
	const tokens = new Set(value.split(/[^a-z0-9_]+/).filter(Boolean));
	if (tokens.has("memory")) return "Archivist";
	if (tokens.has("personal")) return "Concierge";
	if (tokens.has("documents") || tokens.has("writing") || tokens.has("docs")) return "Scribe";
	if (tokens.has("research") || tokens.has("fetch")) return "Scout";
	if (tokens.has("linux")) return "Operator";
	if (tokens.has("profiling")) return "Tuner";
	if (tokens.has("coding")) return "Builder";
	if (tokens.has("readonly") && tokens.has("safety")) return "Sentinel";
	return "Generalist";
}

export function buildSignalParts(statuses: ReadonlyMap<string, string>): string[] {
	const context = findSignal(statuses, ["context-health", "context", "ctx"]);
	const cache = findSignal(statuses, ["cache-guard", "cache", "cached", "hit-rate", "hit rate"]);
	const memory = findSignal(statuses, ["memory", "mem"]);
	const ace = findSignal(statuses, ["ace"]);
	return [
		contextSummary(context),
		cacheSummary(cache),
		memory ? `persona:${memoryPersona(memory.value)}` : undefined,
		ace ? `ace:${plain(ace.value).replace(/^ace\s*:\s*/i, "")}` : undefined,
	].filter(Boolean) as string[];
}

export function buildFooterRight(model: string, branch: string | undefined, thinking: string): string {
	return `${model || "no-model"} · think:${thinking || "unknown"}${branch ? ` (${branch})` : ""}`;
}

export function createTokenTotalsAccumulator(entries: any[] = []) {
	let input = 0;
	let output = 0;
	const record = (message: any): void => {
		if (message?.role !== "assistant") return;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
	};
	const reset = (nextEntries: any[]): void => {
		input = 0; output = 0;
		for (const entry of nextEntries) if (entry?.type === "message") record(entry.message);
	};
	reset(entries);
	return { record, reset, value: () => ({ input, output }) };
}

export default function signalFooter(pi: ExtensionAPI) {
	let enabled = true;
	const totals = createTokenTotalsAccumulator();
	let requestFooterRender: (() => void) | undefined;

	const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

	function apply(ctx: any) {
		if (!ctx.hasUI) return;
		if (!enabled) {
			requestFooterRender = undefined;
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			totals.reset(ctx.sessionManager.getBranch());
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;
			const unsub = footerData.onBranchChange(() => {
				totals.reset(ctx.sessionManager.getBranch());
				requestRender();
			});

			return {
				dispose() {
					unsub();
					if (requestFooterRender === requestRender) requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const statuses = footerData.getExtensionStatuses() as ReadonlyMap<string, string>;
					const sigParts = buildSignalParts(statuses);

					const t = totals.value();
					const leftText = `${sigParts.length ? sigParts.join(" • ") : "signals:-"} • tok ↑${fmt(t.input)} ↓${fmt(t.output)}`;
					const rightText = buildFooterRight(ctx.model?.id || "no-model", footerData.getGitBranch(), String(pi.getThinkingLevel?.() ?? "unknown"));

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
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		totals.record(event.message);
		requestFooterRender?.();
	});
	pi.on("model_select", async (_event, ctx) => { apply(ctx); });
	pi.on("thinking_level_select", async (_event, ctx) => { apply(ctx); });

	pi.registerCommand("status-hud", {
		description: "Toggle compact high-signal global footer (context pressure/cache reuse/memory/tokens)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(enabled ? "High-signal status HUD enabled" : "Default footer restored", "info");
		},
	});
}
