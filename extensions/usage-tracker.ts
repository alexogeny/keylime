import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearPendingContextLedgerRecord, consumePendingContextLedgerRecord, type ContextLedgerRecord } from "./shared/context-ledger";
import { buildSpendSnapshot, type ReportedUsage } from "./shared/spend-accounting";
import { buildPromptPrefixDiagnostic, type PromptPrefixDiagnostic } from "./shared/prompt-prefix-profiler";
import { planProviderCacheControls } from "./shared/provider-token-economics";
import { createTaskOutcomeTracker } from "./shared/task-outcome";
import { createAgentRoutingObserver } from "./shared/agent-routing-observer";

type UsageRecord = {
	version?: 1 | 2;
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
	cacheRead?: number;
	cacheWrite?: number;
	context?: Pick<ContextLedgerRecord, "activeToolFingerprint" | "categories" | "totalChars" | "transforms">;
	spend?: ReturnType<typeof buildSpendSnapshot>;
	promptPrefix?: ReturnType<typeof buildPromptPrefixDiagnostic>;
};

type ProviderMeta = {
	payloadModel?: string;
	payloadProvider?: string;
	responseStatus?: number;
	responseHeaders?: Record<string, string>;
	promptPrefix?: ReturnType<typeof buildPromptPrefixDiagnostic>;
};

const CUSTOM_TYPE_V1 = "usage-record-v1";
const CUSTOM_TYPE = "usage-record-v2";

type RawUsage = Omit<ReportedUsage, "cost"> & { cost?: number | { total?: number } };
type ActiveContext = { chars: number; tokens?: number; percent?: number };

function sumReported(values: unknown[]): number | undefined {
	const reported = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return reported.length > 0 ? reported.reduce((sum, value) => sum + value, 0) : undefined;
}

function usageCost(usage: RawUsage): number | undefined {
	return typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
}

export function buildUsageSpendSnapshot(
	records: Array<Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">>,
	usage: RawUsage,
	activeContext: ActiveContext,
) {
	const current: ReportedUsage = { ...usage, cost: usageCost(usage) };
	return buildSpendSnapshot({
		activeContext,
		currentTurn: current,
		branchTotals: {
			input: sumReported([...records.map(record => record.input), usage.input]),
			output: sumReported([...records.map(record => record.output), usage.output]),
			cacheRead: sumReported([...records.map(record => record.cacheRead), usage.cacheRead]),
			cacheWrite: sumReported([...records.map(record => record.cacheWrite), usage.cacheWrite]),
			cost: sumReported([...records.map(record => record.cost), usageCost(usage)]),
		},
	});
}

export function migrateUsageRecord(record: Record<string, any>): Record<string, any> {
	const spend = record.spend ?? buildSpendSnapshot({
		activeContext: { chars: Number(record.context?.totalChars ?? 0) },
		currentTurn: {
			input: typeof record.input === "number" ? record.input : undefined,
			output: typeof record.output === "number" ? record.output : undefined,
			cacheRead: typeof record.cacheRead === "number" ? record.cacheRead : undefined,
			cacheWrite: typeof record.cacheWrite === "number" ? record.cacheWrite : undefined,
			cost: typeof record.cost === "number" ? record.cost : undefined,
		},
		branchTotals: {
			input: typeof record.input === "number" ? record.input : undefined,
			output: typeof record.output === "number" ? record.output : undefined,
			cacheRead: typeof record.cacheRead === "number" ? record.cacheRead : undefined,
			cacheWrite: typeof record.cacheWrite === "number" ? record.cacheWrite : undefined,
			cost: typeof record.cost === "number" ? record.cost : undefined,
		},
	});
	return { ...record, version: 2, spend };
}

function rounded(value: number): number { return Number(value.toFixed(12)); }

export function createTaskSpendLedger(taskId: string) {
	const calls: Array<{ purpose: string; cost?: number }> = [];
	const pending = new Set<string>();
	return {
		record(call: { purpose: string; cost?: number }) { calls.push({ ...call }); },
		queue(id: string) { pending.add(id); },
		resolve(id: string) { pending.delete(id); },
		complete() { return { complete: pending.size === 0, pending: [...pending].sort() }; },
		snapshot() {
			const totalCostUsd = rounded(calls.reduce((sum, call) => sum + (call.cost ?? 0), 0));
			const auxiliaryCostUsd = rounded(calls.filter(call => call.purpose !== "main").reduce((sum, call) => sum + (call.cost ?? 0), 0));
			return { taskId, modelCalls: calls.length, auxiliaryCostUsd, totalCostUsd };
		},
	};
}

export function sanitizeUsageRecordForPersistence(record: Record<string, any>) {
	const allowed = ["version", "ts", "turnIndex", "taskId", "input", "output", "cost", "cacheRead", "cacheWrite", "modelId", "provider", "routedModel", "routedProvider", "status", "context", "spend", "promptPrefix"];
	return Object.fromEntries(allowed.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
}

export function restoreUsageRuntimeState(entries: Array<Record<string, any>>) {
	const records = entries.filter(entry => entry?.type === "custom" && (entry.customType === CUSTOM_TYPE || entry.customType === CUSTOM_TYPE_V1) && entry.data).map(entry => migrateUsageRecord(entry.data));
	const sum = (key: string) => records.reduce((total, record) => total + (typeof record[key] === "number" ? record[key] : 0), 0);
	const previousPromptPrefix = [...records].reverse().find(record => record.promptPrefix)?.promptPrefix;
	return {
		records,
		branchTotals: {
			uncachedInputTokens: sum("input"), outputTokens: sum("output"), cacheReadTokens: sum("cacheRead"), cacheWriteTokens: sum("cacheWrite"), costUsd: sum("cost"),
		},
		previousPromptPrefix,
	};
}

export default function usageTracker(pi: ExtensionAPI) {
	const records: UsageRecord[] = [];
	const byTurn = new Map<number, ProviderMeta>();
	let currentTurn: number | undefined;
	let previousPromptPrefix: PromptPrefixDiagnostic | undefined;
	let taskCounter = 0;
	let currentTaskId: string | undefined;
	let taskTracker: ReturnType<typeof createTaskOutcomeTracker> | undefined;
	const routingObserver = createAgentRoutingObserver({ mode: "observe-only", maxRecords: 1_000 });

	const logsDir = join(process.cwd(), ".pi", "usage");
	const ndjsonPath = join(logsDir, "usage.ndjson");

	function maybeNum(v: unknown): number {
		return typeof v === "number" && Number.isFinite(v) ? v : 0;
	}

	function maybeOptionalNum(v: unknown): number | undefined {
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	}

	function summarize() {
		let input = 0;
		let output = 0;
		let cost = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		for (const r of records) {
			input += r.input;
			output += r.output;
			cost += r.cost;
			cacheRead += r.cacheRead ?? 0;
			cacheWrite += r.cacheWrite ?? 0;
		}
		return { input, output, cost, cacheRead, cacheWrite, count: records.length };
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
		lines.push(`Cache-read tokens: ${s.cacheRead}`);
		lines.push(`Cache-write tokens: ${s.cacheWrite}`);
		lines.push(`Est. cost: ${s.cost.toFixed(4)}`);
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
		taskTracker = undefined;
		currentTaskId = undefined;
		clearPendingContextLedgerRecord();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && (entry.customType === CUSTOM_TYPE || entry.customType === CUSTOM_TYPE_V1) && entry.data) {
				records.push(entry.data as UsageRecord);
			}
		}
		previousPromptPrefix = [...records].reverse().find(record => record.promptPrefix)?.promptPrefix;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentTaskId = `task-${Date.now().toString(36)}-${++taskCounter}`;
		taskTracker = createTaskOutcomeTracker({
			taskId: currentTaskId,
			repositoryFingerprint: createHash("sha256").update(String(ctx.cwd)).digest("hex"),
			startedAt: Date.now(),
		});
		const activeTools = (pi.getActiveTools?.() ?? []).map((tool: any) => typeof tool === "string" ? tool : tool?.name).filter(Boolean);
		const coding = activeTools.some((name: string) => ["apply_code_replacements", "create_file", "delete_file", "move_file"].includes(name));
		routingObserver.observe({
			taskId: currentTaskId,
			taskKind: coding ? "coding" : "other",
			ambiguity: 0.5,
			risk: coding ? "medium" : "low",
			contextPressure: Number(ctx.getContextUsage?.()?.percent ?? 0) / 100,
			requiresCreativity: coding,
			actual: { provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel?.() },
		});
	});

	pi.on("turn_start", async (event) => {
		currentTurn = event.turnIndex;
	});

	pi.on("tool_call", async (event: any) => {
		taskTracker?.recordToolCall({ toolName: event.toolName, input: event.input });
	});

	pi.on("tool_result", async (event: any) => {
		const verification = event.toolName === "run_checks" && Array.isArray(event.details?.results)
			? event.details.results.map((item: any) => ({
				command: [item.command, ...(item.args ?? [])].filter(Boolean).join(" "),
				passed: item.ok === true,
				diagnosticPaths: item.diagnosticPaths,
			}))
			: undefined;
		taskTracker?.recordToolResult({
			toolName: event.toolName,
			isError: Boolean(event.isError),
			blocked: Boolean(event.details?.blocked),
			changedPaths: event.details?.changedPaths ?? (event.input?.path ? [event.input.path] : []),
			evidenceObjectIds: [event.details?.contextObjectId, event.details?.resultId].filter(Boolean),
			verification,
		});
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (currentTurn === undefined) return;
		const payload = event.payload as Record<string, unknown>;
		const existing = byTurn.get(currentTurn) || {};
		existing.payloadModel = typeof payload.model === "string" ? payload.model : undefined;
		existing.payloadProvider = typeof payload.provider === "string" ? payload.provider : undefined;
		existing.promptPrefix = buildPromptPrefixDiagnostic(previousPromptPrefix, payload);
		previousPromptPrefix = existing.promptPrefix;
		byTurn.set(currentTurn, existing);
		const provider = String(payload.provider ?? (ctx as any)?.model?.provider ?? "");
		const cachePlan = planProviderCacheControls(provider, payload, { ttl: "5m", implicitCaching: /google|gemini/i.test(provider) });
		return cachePlan.changed ? cachePlan.payload : undefined;
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

		const contextRecord = consumePendingContextLedgerRecord();
		const activeContext = ctx.getContextUsage?.();
		const spend = buildUsageSpendSnapshot(records, usage as unknown as RawUsage, {
			chars: contextRecord?.totalChars ?? 0,
			tokens: activeContext?.tokens ?? undefined,
			percent: activeContext?.percent ?? undefined,
		});
		taskTracker?.recordAssistantMessage({ text: "" });
		taskTracker?.recordUsage({
			inputTokens: maybeOptionalNum(usage?.input),
			outputTokens: maybeOptionalNum(usage?.output),
			cacheReadTokens: maybeOptionalNum((usage as any)?.cacheRead),
			cacheWriteTokens: maybeOptionalNum((usage as any)?.cacheWrite),
			costUsd: maybeOptionalNum(usageCost(usage as unknown as RawUsage)),
		});

		const rec: UsageRecord = {
			version: 2,
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
			cacheRead: maybeOptionalNum((usage as any)?.cacheRead),
			cacheWrite: maybeOptionalNum((usage as any)?.cacheWrite),
			context: contextRecord ? {
				activeToolFingerprint: contextRecord.activeToolFingerprint,
				categories: contextRecord.categories,
				totalChars: contextRecord.totalChars,
				transforms: contextRecord.transforms,
			} : undefined,
			spend,
			promptPrefix: turnMeta?.promptPrefix,
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

	pi.on("agent_settled", async () => {
		if (!taskTracker || !currentTaskId) return;
		const outcome = taskTracker.settle({ settledAt: Date.now() });
		taskTracker = undefined;
		pi.appendEntry("task-outcome-v1", outcome);
		const routing = routingObserver.attachOutcome(currentTaskId, outcome);
		pi.appendEntry("agent-routing-observation-v1", routing);
		currentTaskId = undefined;
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
