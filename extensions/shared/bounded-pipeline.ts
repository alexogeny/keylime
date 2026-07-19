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
    aggregate?: Array<{ op: "count" | "sum" | "min" | "max"; field?: string; as: string }>;
  };
};

export type PipelineBudgets = {
  maxCalls: number;
  maxIntermediateChars: number;
  maxOutputChars: number;
};

type Row = Record<string, unknown>;

export type PipelineFailureDetails = {
  failedStepId: string;
  completedStepIds: string[];
  calls: number;
  objectIds: string[];
};

export class PipelineExecutionError extends Error {
  constructor(message: string, readonly details: PipelineFailureDetails) {
    super(message);
    this.name = "PipelineExecutionError";
  }
}

export type PipelineExecutionOptions = {
  maxWallClockMs?: number;
  inlineIntermediateChars?: number;
  storeIntermediate?: (stepId: string, content: string) => Promise<string>;
};

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

function aggregateRows(rows: Row[], specs: NonNullable<PipelinePlan["projection"]["aggregate"]>): Row {
  const output: Row = {};
  for (const spec of specs) {
    const alias = safeField(spec.as);
    const field = spec.field === undefined ? undefined : safeField(spec.field);
    if (spec.op !== "count" && !field) throw new Error(`Aggregate ${spec.op} requires a field`);
    const values = field === undefined
      ? []
      : rows.filter(row => Object.prototype.hasOwnProperty.call(row, field)).map(row => row[field]);
    if (spec.op === "count") {
      output[alias] = field === undefined ? rows.length : values.length;
    } else if (spec.op === "sum") {
      if (values.some(value => typeof value !== "number")) throw new Error(`Aggregate sum requires numeric field: ${field}`);
      output[alias] = (values as number[]).reduce((total, value) => total + value, 0);
    } else if (values.length === 0) {
      output[alias] = null;
    } else {
      output[alias] = values.slice(1).reduce((selected, value) => {
        const order = compare(value, selected);
        return spec.op === "min" ? (order < 0 ? value : selected) : (order > 0 ? value : selected);
      }, values[0]);
    }
  }
  return output;
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
  options: PipelineExecutionOptions = {},
): Promise<{ rows: Row[]; objectIds: string[]; metrics: { calls: number; intermediateChars: number; outputChars: number; inputRows: number; outputRows: number } }> {
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
  const objectIds: string[] = [];
  const completedStepIds: string[] = [];
  let calls = 0;
  let intermediateChars = 0;
  const startedAt = Date.now();
  for (const step of plan.steps) {
    assertNotAborted(signal);
    const operation = registry.get(step.operation)!;
    let value: unknown;
    calls++;
    try {
      const elapsed = Date.now() - startedAt;
      const remaining = options.maxWallClockMs === undefined ? undefined : options.maxWallClockMs - elapsed;
      if (remaining !== undefined && remaining <= 0) throw new Error("Pipeline wall-clock budget exceeded");
      if (remaining === undefined) {
        value = await operation.execute(step.input, signal);
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          value = await Promise.race([
            operation.execute(step.input, signal),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Pipeline wall-clock budget exceeded")), remaining); }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      assertNotAborted(signal);
      const rows = asRows(value, step.id);
      const serialized = JSON.stringify(rows);
      intermediateChars += serialized.length;
      if (intermediateChars > Math.max(0, budgets.maxIntermediateChars)) throw new Error("Pipeline intermediate byte budget exceeded");
      if (options.storeIntermediate && serialized.length > Math.max(0, options.inlineIntermediateChars ?? Number.POSITIVE_INFINITY)) {
        objectIds.push(await options.storeIntermediate(step.id, serialized));
      }
      outputs.set(step.id, rows);
      completedStepIds.push(step.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PipelineExecutionError(`Pipeline step ${step.id} failed: ${message}`, {
        failedStepId: step.id,
        completedStepIds: [...completedStepIds],
        calls,
        objectIds: [...objectIds],
      });
    }
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
  if (plan.projection.limit !== undefined) rows = rows.slice(0, Math.max(0, Math.floor(plan.projection.limit)));
  rows = plan.projection.aggregate?.length
    ? [aggregateRows(rows, plan.projection.aggregate)]
    : rows.map(row => projectRow(row, plan.projection.select));
  const outputChars = JSON.stringify(rows).length;
  if (outputChars > Math.max(0, budgets.maxOutputChars)) throw new Error("Pipeline output byte budget exceeded");
  return { rows, objectIds, metrics: { calls, intermediateChars, outputChars, inputRows, outputRows: rows.length } };
}
