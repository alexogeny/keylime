import { describe, expect, test } from "bun:test";
import {
  createUtilizationRecords,
  markContextUtilization,
  summarizeContextUtilization,
} from "../extensions/shared/retrieval-utilization";

describe("retrieval utilization telemetry", () => {
  test("marks retrieved regions only when later inspected edited or verified", () => {
    let records = createUtilizationRecords("task-1", "repo-a", [
      { path: "src/auth.ts", startLine: 10, endLine: 20, estimatedChars: 200 },
      { path: "src/noise.ts", startLine: 1, endLine: 5, estimatedChars: 100 },
    ], 3);
    records = markContextUtilization(records, {
      taskId: "task-1",
      repositoryMarker: "repo-a",
      path: "src/auth.ts",
      lines: { start: 15, end: 16 },
      kind: "edit",
    });
    records = markContextUtilization(records, {
      taskId: "task-1",
      repositoryMarker: "repo-a",
      path: "src/noise.ts",
      kind: "listing",
    });

    expect(records.find(record => record.path === "src/auth.ts")?.usedBy).toEqual(["edit"]);
    expect(records.find(record => record.path === "src/noise.ts")?.usedBy).toEqual([]);
    expect(summarizeContextUtilization(records)).toEqual({ exploredChars: 300, utilizedChars: 200, utilizedContextRate: 2 / 3 });
  });

  test("does not leak source text or cross repository and task scopes", () => {
    const records = createUtilizationRecords("task-1", "repo-a", [
      { path: "src/auth.ts", startLine: 10, endLine: 20, estimatedChars: 200 },
    ], 3);
    const foreign = markContextUtilization(records, {
      taskId: "task-1",
      repositoryMarker: "repo-b",
      path: "src/auth.ts",
      kind: "verification",
    });
    expect(foreign[0].usedBy).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("sourceText");
    expect(records[0].regionId).toBe("src/auth.ts:10-20");
  });
});
