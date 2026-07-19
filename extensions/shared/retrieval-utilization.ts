export type UtilizationKind = "citation" | "inspection" | "edit" | "verification";

export type ContextUtilizationRecord = {
  taskId: string;
  repositoryMarker: string;
  regionId: string;
  path: string;
  startLine: number;
  endLine: number;
  estimatedChars: number;
  retrievedAtTurn: number;
  usedBy: UtilizationKind[];
};

type RegionSummary = {
  path: string;
  startLine: number;
  endLine: number;
  estimatedChars: number;
};

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function createUtilizationRecords(
  taskId: string,
  repositoryMarker: string,
  regions: RegionSummary[],
  retrievedAtTurn: number,
): ContextUtilizationRecord[] {
  return regions.map(region => {
    const path = normalizedPath(region.path);
    return {
      taskId,
      repositoryMarker,
      regionId: `${path}:${region.startLine}-${region.endLine}`,
      path,
      startLine: region.startLine,
      endLine: region.endLine,
      estimatedChars: region.estimatedChars,
      retrievedAtTurn,
      usedBy: [],
    };
  });
}

export function markContextUtilization(records: ContextUtilizationRecord[], event: {
  taskId: string;
  repositoryMarker: string;
  path: string;
  lines?: { start: number; end: number };
  kind: UtilizationKind | "listing";
}): ContextUtilizationRecord[] {
  if (event.kind === "listing") return records.map(record => ({ ...record, usedBy: [...record.usedBy] }));
  const kind: UtilizationKind = event.kind;
  const path = normalizedPath(event.path);
  return records.map(record => {
    if (record.taskId !== event.taskId || record.repositoryMarker !== event.repositoryMarker || record.path !== path) {
      return { ...record, usedBy: [...record.usedBy] };
    }
    const overlaps = !event.lines || (event.lines.start <= record.endLine && event.lines.end >= record.startLine);
    if (!overlaps) return { ...record, usedBy: [...record.usedBy] };
    return { ...record, usedBy: [...new Set([...record.usedBy, kind])] };
  });
}

export function summarizeContextUtilization(records: ContextUtilizationRecord[]): {
  exploredChars: number;
  utilizedChars: number;
  utilizedContextRate: number;
} {
  const exploredChars = records.reduce((total, record) => total + record.estimatedChars, 0);
  const utilizedChars = records.filter(record => record.usedBy.length > 0).reduce((total, record) => total + record.estimatedChars, 0);
  return { exploredChars, utilizedChars, utilizedContextRate: exploredChars > 0 ? utilizedChars / exploredChars : 0 };
}
