import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { readStoredContextObject, storeContextObject } from "./context-object-store";
import {
  runBoundedToolPipeline,
  type PipelineOperation,
  type PipelinePlan,
} from "./shared/bounded-pipeline";

const OPERATION = "context_object_rows";

function parseRows(content: string, objectId: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Context object ${objectId} does not contain JSON rows`);
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : undefined;
  if (!rows) throw new Error(`Context object ${objectId} does not contain a row array`);
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Context object ${objectId} row ${index} is not an object`);
    return row as Record<string, unknown>;
  });
}

function safeObjectId(callId: string, stepId: string, content: string): string {
  const prefix = `${callId}-${stepId}`.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 60) || "pipeline";
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `pipeline-${prefix}-${hash}`;
}

export default function boundedToolPipelineExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "bounded_tool_pipeline",
    label: "Bounded Tool Pipeline",
    description: "Filter, sort, select, and aggregate verified structured context-object rows under fixed execution and output budgets.",
    promptSnippet: "Aggregate verified stored rows without injecting intermediate payloads",
    promptGuidelines: [
      "Use only the fixed context_object_rows operation; arbitrary tool names, expressions, mutation, fetch, and shell execution are unavailable.",
      "Return compact selected rows and source/object references rather than concatenated intermediate content.",
    ],
    parameters: Type.Object({
      steps: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80 }),
        operation: Type.Literal(OPERATION),
        input: Type.Object({ object_id: Type.String({ minLength: 1, maxLength: 160 }) }),
      }), { minItems: 1, maxItems: 12 }),
      projection: Type.Object({
        from: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 12 }),
        select: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 50 })),
        filters: Type.Optional(Type.Array(Type.Object({
          field: Type.String({ minLength: 1, maxLength: 100 }),
          op: Type.Union([Type.Literal("eq"), Type.Literal("contains"), Type.Literal("gt"), Type.Literal("lt")]),
          value: Type.Unknown(),
        }), { maxItems: 20 })),
        sort: Type.Optional(Type.Array(Type.Object({
          field: Type.String({ minLength: 1, maxLength: 100 }),
          direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
        }), { maxItems: 10 })),
        limit: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
        aggregate: Type.Optional(Type.Array(Type.Object({
          op: Type.Union([Type.Literal("count"), Type.Literal("sum"), Type.Literal("min"), Type.Literal("max")]),
          field: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          as: Type.String({ minLength: 1, maxLength: 100 }),
        }), { maxItems: 20 })),
      }),
      budgets: Type.Object({
        max_calls: Type.Number({ minimum: 1, maximum: 12 }),
        max_intermediate_chars: Type.Number({ minimum: 100, maximum: 2_000_000 }),
        max_output_chars: Type.Number({ minimum: 100, maximum: 50_000 }),
        max_wall_clock_ms: Type.Number({ minimum: 1, maximum: 30_000 }),
      }),
    }),
    async execute(callId, params, signal, _onUpdate, ctx) {
      for (const step of params.steps as Array<{ operation: string }>) {
        if (step.operation !== OPERATION) throw new Error(`Unsupported pipeline operation: ${step.operation}`);
      }
      const cwd = ctx?.cwd ?? process.cwd();
      const sourceObjectIds: string[] = [];
      const registry = new Map<string, PipelineOperation>([[OPERATION, {
        risk: "safe",
        execute: async input => {
          const objectId = input.object_id;
          if (typeof objectId !== "string") throw new Error("context_object_rows requires object_id");
          const payload = await readStoredContextObject(cwd, objectId);
          sourceObjectIds.push(payload.object.id);
          return parseRows(payload.content, payload.object.id);
        },
      }]]);
      const result = await runBoundedToolPipeline({
        steps: params.steps,
        projection: params.projection,
      } as PipelinePlan, registry, {
        maxCalls: params.budgets.max_calls,
        maxIntermediateChars: params.budgets.max_intermediate_chars,
        maxOutputChars: params.budgets.max_output_chars,
      }, signal ?? new AbortController().signal, {
        maxWallClockMs: params.budgets.max_wall_clock_ms,
        inlineIntermediateChars: Math.min(4_000, params.budgets.max_intermediate_chars),
        storeIntermediate: async (stepId, content) => {
          const stored = await storeContextObject(cwd, {
            id: safeObjectId(callId, stepId, content),
            kind: "generic",
            sourceTool: "bounded_tool_pipeline",
            toolCallId: callId,
            content,
            summary: `Oversized intermediate rows from pipeline step ${stepId}`,
            retention: "reconstructable",
            dependencies: [...sourceObjectIds],
          });
          return `object://${stored.object.id}`;
        },
      });
      const payload = { rows: result.rows, objectIds: result.objectIds, sourceObjectIds: [...new Set(sourceObjectIds)] };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: { success: true, ...payload, metrics: result.metrics },
      };
    },
  });
}
