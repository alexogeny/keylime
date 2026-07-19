import { readFileSync } from "node:fs";
import { estimateRegisteredToolChars } from "../../extensions/shared/tool-catalog";
import { bootstrapToolNames, TOOL_POLICIES } from "../../extensions/shared/tool-policy";
import { reduceToolResultText } from "../../extensions/shared/tool-result-reducers";
import { renderCompactionCheckpoint, validateCompactionCheckpoint, type CompactionCheckpoint } from "../../extensions/shared/compaction-schema";
import { rankCodeRegions, type CodeRegionBudget, type CodeRegionCandidate } from "../../extensions/shared/repo-regions";
import { bindRepositoryState, loadBoundRepositoryState, type RepositoryIdentity } from "../../extensions/shared/repository-identity";
import { codingModeBlockReasonForToolCall } from "../../extensions/danger-guard";

export type ContextEvalReportCategory = {
  category: "tool-selection" | "tool-results" | "compaction" | "repository-retrieval" | "stale-state" | "safety";
  beforeChars: number;
  afterChars: number;
  reductionRate: number;
  recoverableRemovedChars: number;
  unrecoverableRemovedChars: number;
  qualityPass: boolean;
  safetyPass: boolean;
  metrics?: Record<string, number>;
};

function fixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${relativePath}`, import.meta.url), "utf8")) as T;
}

function row(
  category: ContextEvalReportCategory["category"],
  before: string | number,
  after: string | number,
  options: Partial<Pick<ContextEvalReportCategory, "recoverableRemovedChars" | "unrecoverableRemovedChars" | "qualityPass" | "safetyPass" | "metrics">> = {},
): ContextEvalReportCategory {
  const beforeChars = typeof before === "number" ? before : before.length;
  const afterChars = typeof after === "number" ? after : after.length;
  return {
    category,
    beforeChars,
    afterChars,
    reductionRate: beforeChars > 0 ? (beforeChars - afterChars) / beforeChars : 0,
    recoverableRemovedChars: options.recoverableRemovedChars ?? 0,
    unrecoverableRemovedChars: options.unrecoverableRemovedChars ?? 0,
    qualityPass: options.qualityPass ?? true,
    safetyPass: options.safetyPass ?? true,
    metrics: options.metrics,
  };
}

export function buildContextEvalReport(): { version: 1; categories: ContextEvalReportCategory[] } {
  const catalog = TOOL_POLICIES.map(policy => ({
    name: policy.name,
    description: policy.name.replace(/_/g, " "),
    parameters: { type: "object", properties: { query: { type: "string" } } },
  }));
  const bootstrap = new Set(bootstrapToolNames());
  const allSchemaChars = estimateRegisteredToolChars(catalog);
  const bootstrapSchemaChars = estimateRegisteredToolChars(catalog.filter(tool => bootstrap.has(tool.name)));

  const toolResult = fixture<{ toolName: string; content: string; requiredFacts: string[]; maxActiveChars: number }>("tool-results/failing-test.json");
  const reduced = reduceToolResultText(toolResult.toolName, toolResult.content, { maxChars: toolResult.maxActiveChars });
  const toolResultQuality = toolResult.requiredFacts.every(fact => reduced.activeText.includes(fact));
  const toolResultRemoved = Math.max(0, toolResult.content.length - reduced.activeText.length);

  const compaction = fixture<{ checkpoint: CompactionCheckpoint; requiredFacts: string[]; expectedNextAction: string }>("compaction/continuation.json");
  const checkpoint = validateCompactionCheckpoint(compaction.checkpoint);
  const rendered = renderCompactionCheckpoint(checkpoint);
  const compactionQuality = compaction.requiredFacts.every(fact => rendered.includes(fact))
    && checkpoint.pendingActions[0]?.text === compaction.expectedNextAction;

  const retrieval = fixture<{
    budget: CodeRegionBudget; candidates: CodeRegionCandidate[]; requiredRegionIds: string[]; minimumRecall: number; minimumPrecision: number;
  }>("repository-retrieval/gold-regions.json");
  const ranked = rankCodeRegions(retrieval.candidates, retrieval.budget);
  const returnedIds = new Set(ranked.regions.map(region => `${region.path}:${region.startLine}-${region.endLine}`));
  const requiredReturned = retrieval.requiredRegionIds.filter(id => returnedIds.has(id)).length;
  const recall = requiredReturned / retrieval.requiredRegionIds.length;
  const precision = requiredReturned / ranked.regions.length;

  const state = fixture<{
    expectedRepository: RepositoryIdentity; foreignRepository: RepositoryIdentity; foreignPayload: Record<string, unknown>;
    blockedTool: { name: string; input: Record<string, unknown> }; requiredDenial: string;
  }>("stale-state/foreign-and-blocked.json");
  const envelope = bindRepositoryState(state.foreignRepository, state.foreignPayload, 1);
  const loaded = loadBoundRepositoryState(envelope, state.expectedRepository, ".pi/project.json");
  const denial = codingModeBlockReasonForToolCall(state.blockedTool.name, state.blockedTool.input) ?? "";

  return {
    version: 1,
    categories: [
      row("tool-selection", allSchemaChars, bootstrapSchemaChars, { metrics: { schemaReductionRate: 1 - bootstrapSchemaChars / allSchemaChars } }),
      row("tool-results", toolResult.content, reduced.activeText, { recoverableRemovedChars: toolResultRemoved, qualityPass: toolResultQuality }),
      row("compaction", JSON.stringify(checkpoint), rendered, { qualityPass: compactionQuality, safetyPass: rendered.includes("Default Pi compaction remains fallback") }),
      row("repository-retrieval", JSON.stringify(retrieval.candidates), JSON.stringify(ranked.regions), {
        qualityPass: recall >= retrieval.minimumRecall && precision >= retrieval.minimumPrecision,
        metrics: { recall, precision, returnedLines: ranked.metrics.returnedLines, returnedChars: ranked.metrics.returnedChars },
      }),
      row("stale-state", JSON.stringify(envelope), loaded.status, { qualityPass: loaded.status === "mismatch" }),
      row("safety", JSON.stringify(state.blockedTool), denial, { safetyPass: denial.includes(state.requiredDenial) }),
    ],
  };
}

if (import.meta.main) console.log(JSON.stringify(buildContextEvalReport(), null, 2));
