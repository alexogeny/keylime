import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type UsageRecord = {
	ts: number;
	turnIndex?: number;
	input: number;
	output: number;
	cost: number;
	modelId?: string;
	provider?: string;
	routedModel?: string;
	routedProvider?: string;
	status?: number;
};

type ProviderMeta = {
	payloadModel?: string;
	payloadProvider?: string;
	responseStatus?: number;
	responseHeaders?: Record<string, string>;
};

const CUSTOM_TYPE = "usage-record-v1";

export default function usageTracker(pi: ExtensionAPI) {
	const records: UsageRecord[] = [];
	const byTurn = new Map<number, ProviderMeta>();
	let currentTurn: number | undefined;

	const logsDir = join(process.cwd(), ".pi", "usage");
	const ndjsonPath = join(logsDir, "usage.ndjson");

	function maybeNum(v: unknown): number {
		return typeof v === "number" && Number.isFinite(v) ? v : 0;
	}

	function summarize() {
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const r of records) {
			input += r.input;
			output += r.output;
			cost += r.cost;
		}
		return { input, output, cost, count: records.length };
	}

	function providerBreakdown() {
		const m = new Map<string, { count: number; input: number; output: number; cost: number }>();
		for (const r of records) {
			const key = r.routedProvider || r.provider || "unknown";
			const cur = m.get(key) || { count: 0, input: 0, output: 0, cost: 0 };
			cur.count += 1;
			cur.input += r.input;
			cur.output += r.output;
			cur.cost += r.cost;
			m.set(key, cur);
		}
		return [...m.entries()].sort((a, b) => b[1].output - a[1].output);
	}

	function makeReport() {
		const s = summarize();
		const lines: string[] = [];
		lines.push("# Usage report");
		lines.push("");
		lines.push(`Messages: ${s.count}`);
		lines.push(`Input tokens: ${s.input}`);
		lines.push(`Output tokens: ${s.output}`);
		lines.push(`Est. cost: $${s.cost.toFixed(4)}`);
		lines.push("");
		lines.push("## By provider/route");
		for (const [k, v] of providerBreakdown()) {
			lines.push(`- ${k}: ${v.count} msgs | in ${v.input} | out ${v.output} | $${v.cost.toFixed(4)}`);
		}
		lines.push("");
		lines.push("## Last 20 messages");
		for (const r of records.slice(-20)) {
			lines.push(
				`- ${new Date(r.ts).toISOString()} | turn ${r.turnIndex ?? "?"} | ${r.provider ?? "?"} -> ${r.routedProvider ?? "?"} | ${r.modelId ?? "?"} -> ${r.routedModel ?? "?"} | in ${r.input} out ${r.output} | $${r.cost.toFixed(4)}${r.status ? ` | HTTP ${r.status}` : ""}`,
			);
		}
		return lines.join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		records.length = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
				records.push(entry.data as UsageRecord);
			}
		}
	});

	pi.on("turn_start", async (event) => {
		currentTurn = event.turnIndex;
	});

	pi.on("before_provider_request", (event) => {
		if (currentTurn === undefined) return;
		const payload = event.payload as Record<string, unknown>;
		const existing = byTurn.get(currentTurn) || {};
		existing.payloadModel = typeof payload.model === "string" ? payload.model : undefined;
		existing.payloadProvider = typeof payload.provider === "string" ? payload.provider : undefined;
		byTurn.set(currentTurn, existing);
	});

	pi.on("after_provider_response", (event) => {
		if (currentTurn === undefined) return;
		const existing = byTurn.get(currentTurn) || {};
		existing.responseStatus = event.status;
		existing.responseHeaders = event.headers;
		byTurn.set(currentTurn, existing);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const usage = event.message.usage;
		const m: any = ctx.model;
		const turnMeta = currentTurn !== undefined ? byTurn.get(currentTurn) : undefined;
		const routedProvider =
			turnMeta?.responseHeaders?.["x-openrouter-provider"] ||
			turnMeta?.responseHeaders?.["openrouter-provider"] ||
			turnMeta?.payloadProvider;
		const routedModel =
			turnMeta?.responseHeaders?.["x-openrouter-model"] ||
			turnMeta?.responseHeaders?.["openrouter-model"] ||
			turnMeta?.payloadModel;

		const rec: UsageRecord = {
			ts: Date.now(),
			turnIndex: currentTurn,
			input: maybeNum(usage?.input),
			output: maybeNum(usage?.output),
			cost: maybeNum(usage?.cost?.total),
			modelId: typeof m?.id === "string" ? m.id : undefined,
			provider: typeof m?.provider === "string" ? m.provider : undefined,
			routedModel,
			routedProvider,
			status: turnMeta?.responseStatus,
		};

		records.push(rec);
		pi.appendEntry(CUSTOM_TYPE, rec);

		try {
			mkdirSync(logsDir, { recursive: true });
			appendFileSync(ndjsonPath, `${JSON.stringify(rec)}\n`, "utf8");
		} catch {
			// best effort
		}
	});

	pi.registerCommand("usage", {
		description: "Show token/provider usage tracked by this session",
		handler: async (args, ctx) => {
			if (args[0] === "reset") {
				records.length = 0;
				ctx.ui.notify("Usage tracker reset (session memory)", "info");
				return;
			}

			const report = makeReport();
			if (ctx.hasUI) {
				ctx.ui.setEditorText(report);
				ctx.ui.notify(`Usage report loaded in editor (${records.length} rows)`, "info");
			} else {
				console.log(report);
			}
		},
	});
}
