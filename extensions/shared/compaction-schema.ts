import { Type } from "typebox";

export type CompactionEvidenceStatus = "active" | "resolved" | "superseded";

export type CompactionLocator = {
  path?: string;
  lines?: { start: number; end: number };
  section?: string;
  resultId?: string;
};

export type EvidenceClaim = {
  text: string;
  sourceEntryIds?: string[];
  objectIds?: string[];
  status?: CompactionEvidenceStatus;
};

export type CompactionCheckpoint = {
  version: 1;
  goal: string;
  constraints: EvidenceClaim[];
  acceptanceCriteria: EvidenceClaim[];
  decisions: EvidenceClaim[];
  activeFiles: Array<{
    path: string;
    relevance: string;
    contentHash?: string;
    locators?: CompactionLocator[];
  }>;
  changes: EvidenceClaim[];
  verification: EvidenceClaim[];
  failures: EvidenceClaim[];
  blockers: EvidenceClaim[];
  pendingActions: EvidenceClaim[];
  safetyState: EvidenceClaim[];
  objectIds: string[];
};

const OBJECT_ID_PATTERN = "^[a-zA-Z0-9_.:-]+$";
const OBJECT_ID = new RegExp(OBJECT_ID_PATTERN);

const EvidenceClaimSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  sourceEntryIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  objectIds: Type.Optional(Type.Array(Type.String({ pattern: OBJECT_ID_PATTERN }))),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("resolved"), Type.Literal("superseded")])),
});

const LocatorSchema = Type.Object({
  path: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Object({ start: Type.Number({ minimum: 1 }), end: Type.Number({ minimum: 1 }) })),
  section: Type.Optional(Type.String()),
  resultId: Type.Optional(Type.String({ pattern: OBJECT_ID_PATTERN })),
});

export const CompactionCheckpointSchema = Type.Object({
  version: Type.Literal(1),
  goal: Type.String({ minLength: 1 }),
  constraints: Type.Array(EvidenceClaimSchema),
  acceptanceCriteria: Type.Array(EvidenceClaimSchema),
  decisions: Type.Array(EvidenceClaimSchema),
  activeFiles: Type.Array(Type.Object({
    path: Type.String(),
    relevance: Type.String(),
    contentHash: Type.Optional(Type.String()),
    locators: Type.Optional(Type.Array(LocatorSchema)),
  })),
  changes: Type.Array(EvidenceClaimSchema),
  verification: Type.Array(EvidenceClaimSchema),
  failures: Type.Array(EvidenceClaimSchema),
  blockers: Type.Array(EvidenceClaimSchema),
  pendingActions: Type.Array(EvidenceClaimSchema),
  safetyState: Type.Array(EvidenceClaimSchema),
  objectIds: Type.Array(Type.String({ pattern: OBJECT_ID_PATTERN })),
});
const CLAIM_KEYS = [
  "constraints",
  "acceptanceCriteria",
  "decisions",
  "changes",
  "verification",
  "failures",
  "blockers",
  "pendingActions",
  "safetyState",
] as const;

function assertObjectIds(ids: unknown, field: string): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !OBJECT_ID.test(id))) {
    throw new Error(`${field} must contain valid context object ids`);
  }
}

function validateClaims(value: unknown, field: string): asserts value is EvidenceClaim[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const claim of value) {
    if (!claim || typeof claim !== "object" || typeof claim.text !== "string" || !claim.text.trim()) {
      throw new Error(`${field} claims require non-empty text`);
    }
    if (claim.sourceEntryIds !== undefined && (!Array.isArray(claim.sourceEntryIds) || claim.sourceEntryIds.some((id: unknown) => typeof id !== "string" || !id))) {
      throw new Error(`${field}.sourceEntryIds must contain strings`);
    }
    if (claim.objectIds !== undefined) assertObjectIds(claim.objectIds, `${field}.objectIds`);
    if (claim.status !== undefined && !["active", "resolved", "superseded"].includes(claim.status)) {
      throw new Error(`${field}.status is invalid`);
    }
  }
}

function validateLocator(locator: CompactionLocator, field: string): void {
  if (!locator || typeof locator !== "object") throw new Error(`${field} locator is invalid`);
  if (locator.path !== undefined && typeof locator.path !== "string") throw new Error(`${field}.path must be a string`);
  if (locator.lines) {
    if (!Number.isInteger(locator.lines.start) || !Number.isInteger(locator.lines.end)
      || locator.lines.start < 1 || locator.lines.end < locator.lines.start) {
      throw new Error(`${field}.lines must be positive and ordered`);
    }
  }
  if (locator.resultId !== undefined && !OBJECT_ID.test(locator.resultId)) throw new Error(`${field}.resultId is invalid`);
}

export function validateCompactionCheckpoint(value: unknown): CompactionCheckpoint {
  const checkpoint = value as Partial<CompactionCheckpoint> | undefined;
  if (!checkpoint || typeof checkpoint !== "object") throw new Error("checkpoint must be an object");
  if (checkpoint.version !== 1) throw new Error("version must be 1");
  if (typeof checkpoint.goal !== "string" || !checkpoint.goal.trim()) throw new Error("goal must be non-empty");
  for (const key of CLAIM_KEYS) validateClaims(checkpoint[key], key);
  if (!Array.isArray(checkpoint.activeFiles)) throw new Error("activeFiles must be an array");
  for (const [index, file] of checkpoint.activeFiles.entries()) {
    if (!file || typeof file.path !== "string" || typeof file.relevance !== "string") throw new Error(`activeFiles[${index}] is invalid`);
    for (const locator of file.locators ?? []) validateLocator(locator, `activeFiles[${index}].locators`);
  }
  assertObjectIds(checkpoint.objectIds, "objectIds");
  return checkpoint as CompactionCheckpoint;
}

function renderClaim(claim: EvidenceClaim): string {
  const refs = [
    ...(claim.sourceEntryIds ?? []).map(id => `entry://${id}`),
    ...(claim.objectIds ?? []).map(id => `object://${id}`),
  ];
  return `- ${claim.text}${claim.status ? ` [${claim.status}]` : ""}${refs.length ? ` (${refs.join(", ")})` : ""}`;
}

function heading(label: string, claims: EvidenceClaim[]): string[] {
  return [`## ${label}`, ...(claims.length ? claims.map(renderClaim) : ["- none"])];
}

export function renderCompactionCheckpoint(input: CompactionCheckpoint): string {
  const checkpoint = validateCompactionCheckpoint(input);
  const lines = [
    "# Keylime Compaction Checkpoint",
    `Goal: ${checkpoint.goal}`,
    ...heading("Constraints", checkpoint.constraints),
    ...heading("Acceptance Criteria", checkpoint.acceptanceCriteria),
    ...heading("Decisions", checkpoint.decisions),
    "## Active Files",
  ];
  if (checkpoint.activeFiles.length === 0) lines.push("- none");
  for (const file of checkpoint.activeFiles) {
    lines.push(`- ${file.path} — ${file.relevance}${file.contentHash ? ` hash=${file.contentHash}` : ""}`);
    for (const locator of file.locators ?? []) {
      const path = locator.path ?? file.path;
      const range = locator.lines ? `:${locator.lines.start}-${locator.lines.end}` : "";
      const suffix = [locator.section ? `section=${locator.section}` : "", locator.resultId ? `result://${locator.resultId}` : ""].filter(Boolean).join(" ");
      lines.push(`  - ${path}${range}${suffix ? ` ${suffix}` : ""}`);
    }
  }
  lines.push(
    ...heading("Changes", checkpoint.changes),
    ...heading("Verification", checkpoint.verification),
    ...heading("Failures", checkpoint.failures),
    ...heading("Blockers", checkpoint.blockers),
    ...heading("Pending Actions", checkpoint.pendingActions),
    ...heading("Safety State", checkpoint.safetyState),
    "## Context Objects",
    ...(checkpoint.objectIds.length ? checkpoint.objectIds.map(id => `- object://${id}`) : ["- none"]),
  );
  return lines.join("\n");
}
