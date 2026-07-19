export type Observation = {
  id: string;
  toolName: string;
  text: string;
  turn: number;
  kind: "success" | "failure" | "constraint" | "safety" | "state";
  objectId?: string;
  supersedes?: string[];
  referencedBy?: string[];
};

export type ObservationTier = "hot" | "warm" | "cold";
export type LifecycleObservation = Observation & { tier: ObservationTier; rendered: string };
export type ObservationLifecycleResult = { observations: LifecycleObservation[]; rendered: string };

export type ObservationLifecycleOptions = {
  currentTurn?: number;
  hotTurns?: number;
  warmTurns?: number;
  activeReferences?: string[];
};

function tombstone(observation: Observation): string {
  const recovery = observation.objectId ? ` — recover with context object ${observation.objectId}` : "";
  return `[masked ${observation.toolName} observation ${observation.id}${recovery}]`;
}

export function applyObservationLifecycle(observations: Observation[], options: ObservationLifecycleOptions = {}): ObservationLifecycleResult {
  const currentTurn = options.currentTurn ?? Math.max(0, ...observations.map(item => item.turn));
  const hotTurns = options.hotTurns ?? 2;
  const warmTurns = options.warmTurns ?? 8;
  const active = new Set(options.activeReferences ?? []);
  const superseded = new Set(observations.flatMap(item => item.supersedes ?? []));

  const result = observations.map(observation => {
    const age = Math.max(0, currentTurn - observation.turn);
    const protectedKind = observation.kind === "constraint" || observation.kind === "safety" || observation.kind === "failure";
    const activelyReferenced = (observation.referencedBy ?? []).some(reference => active.has(reference));
    let tier: ObservationTier;
    if (superseded.has(observation.id) && !protectedKind) tier = "cold";
    else if (age <= hotTurns) tier = "hot";
    else if (protectedKind || activelyReferenced || age <= warmTurns || !observation.objectId) tier = "warm";
    else tier = "cold";
    return { ...observation, tier, rendered: tier === "cold" ? tombstone(observation) : observation.text };
  });

  return { observations: result, rendered: result.map(item => item.rendered).join("\n") };
}
