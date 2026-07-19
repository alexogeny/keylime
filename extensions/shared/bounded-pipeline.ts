export type PipelineRisk = "safe" | "guarded" | "stateful" | "dangerous";

export type PipelineOperation = {
  risk: PipelineRisk;
  execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
};

export type PipelinePlan = {
  steps: Array<{ id: string; operation: string; input: Record<string, unknown> }>;
  projection: {
    from: string[];
    select?: string[];
    filters?: Array<{ field: string; op: "eq" | "contains" | "gt" | "lt"; value: unknown }>;
    sort?: Array<{ field: string; direction: "asc" | "desc" }>;
    limit?: number;
  };
};

export type PipelineBudgets = {
  maxCalls: number;
  maxIntermediateChars: number;
  maxOutputChars: number;
};

type Row = Record<string, unknown>;

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Pipeline aborted");
}

function safeField(field: string): string {
  if (!field || field === "__proto__" || field === "prototype" || field === "constructor" || field.includes(".")) {
    throw new Error(`Unsafe pipeline field: ${field}`);
  }
  return field;
}

function asRows(value: unknown, stepId: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`Pipeline step ${stepId} must return an array of rows`);
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Pipeline step ${stepId} row ${index} is not an object`);
    return row as Row;
  });
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function matches(row: Row, filter: { field: string; op: "eq" | "contains" | "gt" | "lt"; value: unknown }): boolean {
  const field = safeField(filter.field);
  const actual = Object.prototype.hasOwnProperty.call(row, field) ? row[field] : undefined;
  if (filter.op === "eq") return actual === filter.value;
  if (filter.op === "contains") return String(actual ?? "").includes(String(filter.value ?? ""));
  if (filter.op === "gt") return compare(actual, filter.value) > 0;
  return compare(actual, filter.value) < 0;
}

function projectRow(row: Row, fields: string[] | undefined): Row {
  if (!fields) return { ...row };
  const output: Row = {};
  for (const rawField of fields) {
    const field = safeField(rawField);
    if (Object.prototype.hasOwnProperty.call(row, field)) output[field] = row[field];
  }
  return output;
}

export async function runBoundedToolPipeline(
  plan: PipelinePlan,
  registry: ReadonlyMap<string, PipelineOperation>,
  budgets: PipelineBudgets,
  signal: AbortSignal,
): Promise<{ rows: Row[]; metrics: { calls: number; intermediateChars: number; outputChars: number; inputRows: number; outputRows: number } }> {
  assertNotAborted(signal);
  if (plan.steps.length > Math.max(0, Math.floor(budgets.maxCalls))) throw new Error("Pipeline call budget exceeded");
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id || stepIds.has(step.id)) throw new Error(`Duplicate or empty pipeline step id: ${step.id}`);
    stepIds.add(step.id);
    const operation = registry.get(step.operation);
    if (!operation) throw new Error(`Unknown pipeline operation: ${step.operation}`);
    if (operation.risk !== "safe") throw new Error(`Pipeline operation is not safe: ${step.operation}`);
  }
  for (const source of plan.projection.from) if (!stepIds.has(source)) throw new Error(`Unknown projection source: ${source}`);

  const outputs = new Map<string, Row[]>();
  let intermediateChars = 0;
  for (const step of plan.steps) {
    assertNotAborted(signal);
    const operation = registry.get(step.operation)!;
    let value: unknown;
    try {
      value = await operation.execute(step.input, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Pipeline step ${step.id} failed: ${message}`);
    }
    assertNotAborted(signal);
    const rows = asRows(value, step.id);
    intermediateChars += JSON.stringify(rows).length;
    if (intermediateChars > Math.max(0, budgets.maxIntermediateChars)) throw new Error("Pipeline intermediate byte budget exceeded");
    outputs.set(step.id, rows);
  }

  let rows = plan.projection.from.flatMap(id => outputs.get(id) ?? []);
  const inputRows = rows.length;
  for (const filter of plan.projection.filters ?? []) rows = rows.filter(row => matches(row, filter));
  if (plan.projection.sort?.length) {
    rows = rows.slice().sort((left, right) => {
      for (const sort of plan.projection.sort!) {
        const field = safeField(sort.field);
        const value = compare(left[field], right[field]);
        if (value !== 0) return sort.direction === "desc" ? -value : value;
      }
      return JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
  }
  rows = rows.map(row => projectRow(row, plan.projection.select));
  if (plan.projection.limit !== undefined) rows = rows.slice(0, Math.max(0, Math.floor(plan.projection.limit)));
  const outputChars = JSON.stringify(rows).length;
  if (outputChars > Math.max(0, budgets.maxOutputChars)) throw new Error("Pipeline output byte budget exceeded");
  return { rows, metrics: { calls: plan.steps.length, intermediateChars, outputChars, inputRows, outputRows: rows.length } };
}
