export type TrajectoryEvent = { id: string; subtask: string; type: "action" | "evidence" | "decision" | "failure" | "verification" | "constraint" | "safety"; text: string; objectIds?: string[]; resolved?: boolean };
export type TrajectoryFold = { id: string; level: "granular" | "deep"; subtask: string; goal: string; outcome: string; facts: string[]; failures: string[]; pending: string[]; objectIds: string[]; sourceEventIds: string[] };
export type FoldOptions = { level: "granular" | "deep"; completedSubtasks?: string[]; activeSubtask?: string };

function unique(values: string[]): string[] { return [...new Set(values)]; }

export function foldTrajectory(events: TrajectoryEvent[], options: FoldOptions): TrajectoryFold {
  const subtask = events[0]?.subtask ?? options.activeSubtask ?? "trajectory";
  const facts = unique(events.filter(event => ["evidence", "constraint", "safety"].includes(event.type)).map(event => event.text));
  const failures = unique(events.filter(event => event.type === "failure").map(event => event.text));
  const activeEvents = events.filter(event => event.subtask === options.activeSubtask);
  const pending = unique(activeEvents.filter(event => event.type === "decision" || (event.type === "failure" && !event.resolved)).map(event => event.text));
  const evidence = events.find(event => event.type === "evidence")?.text;
  const verification = [...events].reverse().find(event => event.type === "verification")?.text;
  const outcome = verification ?? evidence ?? events.at(-1)?.text ?? "No outcome recorded";
  return {
    id: `fold:${options.level}:${unique(events.map(event => event.id)).join(",")}`,
    level: options.level,
    subtask,
    goal: `Complete ${subtask}`,
    outcome,
    facts,
    failures,
    pending,
    objectIds: unique(events.flatMap(event => event.objectIds ?? [])),
    sourceEventIds: unique(events.map(event => event.id)),
  };
}

export function shouldFoldTrajectory(event: { kind: string; contextPercent: number }): boolean {
  return event.contextPercent >= 85 || ["subtask_completed", "file_switched", "phase_changed", "failure_resolved"].includes(event.kind);
}
