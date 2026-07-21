export type TrajectoryItem = {
  id: string;
  role: string;
  kind: string;
  text: string;
  ageTurns: number;
  protected?: boolean;
  toolCallId?: string;
  toolName?: string;
  recoverableObjectId?: string;
};

export type ReductionAction = {
  id: string;
  action: "retain" | "reference" | "fold";
  reason: string;
};

function referenceText(item: TrajectoryItem): string {
  return `[recoverable ${item.kind}; context object ${item.recoverableObjectId}; original ${item.text.length} chars]`;
}

export function planTrajectoryReduction(items: TrajectoryItem[], policy: { hotTurns: number; warmTurns: number }) {
  const hasLaterVerification = items.some(item => item.kind === "verification");
  let recoverableCharsRemoved = 0;
  let failuresFolded = 0;
  const actions: ReductionAction[] = [];
  const messages = items.map(item => {
    if (!item.protected && item.recoverableObjectId && item.ageTurns > policy.hotTurns) {
      const text = referenceText(item);
      recoverableCharsRemoved += Math.max(0, item.text.length - text.length);
      actions.push({ id: item.id, action: "reference", reason: "stale recoverable observation replaced by durable reference" });
      return { ...item, text };
    }
    if (item.kind === "failure" && hasLaterVerification) {
      failuresFolded++;
      actions.push({ id: item.id, action: "fold", reason: "resolved failure retained as bounded diagnostic evidence" });
      return { ...item, text: item.text.slice(0, 500) };
    }
    actions.push({ id: item.id, action: "retain", reason: item.protected ? "protected task state" : item.ageTurns <= policy.hotTurns ? "hot trajectory window" : "non-recoverable trajectory evidence" });
    return { ...item };
  });
  return {
    messages,
    actions,
    report: {
      beforeChars: items.reduce((sum, item) => sum + item.text.length, 0),
      afterChars: messages.reduce((sum, item) => sum + item.text.length, 0),
      recoverableCharsRemoved,
      failuresFolded,
    },
  };
}

export function validateToolPairing(items: TrajectoryItem[]): { valid: boolean; orphanedCallIds: string[] } {
  const callIds = new Set(items.filter(item => item.kind === "tool_call" && item.toolCallId).map(item => item.toolCallId as string));
  const resultIds = new Set(items.filter(item => item.role === "tool" && item.toolCallId).map(item => item.toolCallId as string));
  const orphanedCallIds = [...new Set([...callIds].filter(id => !resultIds.has(id)).concat([...resultIds].filter(id => !callIds.has(id))))].sort();
  return { valid: orphanedCallIds.length === 0, orphanedCallIds };
}
