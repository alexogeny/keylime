import { createHash } from "node:crypto";

export type ContextSegment = { id: string; stability: "static" | "session" | "turn"; content: string; toolSchemas?: string[] };
export type CacheStableAssembly = { text: string; orderedSegmentIds: string[]; stablePrefix: string; volatileSuffix: string; fingerprint: string };

const rank = { static: 0, session: 1, turn: 2 } as const;
function render(segment: ContextSegment): string {
  const schemas = [...(segment.toolSchemas ?? [])].sort();
  return schemas.length ? `${segment.content}\n${schemas.join("\n")}` : segment.content;
}

export function assembleCacheStableContext(segments: ContextSegment[], _options: Record<string, unknown> = {}): CacheStableAssembly {
  const ordered = [...segments].sort((a, b) => rank[a.stability] - rank[b.stability] || a.id.localeCompare(b.id));
  const stable = ordered.filter(segment => segment.stability !== "turn");
  const volatile = ordered.filter(segment => segment.stability === "turn");
  const stablePrefix = stable.map(render).join("\n");
  const volatileSuffix = volatile.map(render).join("\n");
  const text = stablePrefix + volatileSuffix;
  return {
    text,
    orderedSegmentIds: ordered.map(segment => segment.id),
    stablePrefix,
    volatileSuffix,
    fingerprint: createHash("sha256").update(stablePrefix).digest("hex"),
  };
}

export function maskToolAvailability(schemas: string[], active: string[]): { schemas: string[]; mask: Record<string, boolean> } {
  const stableSchemas = [...schemas];
  const activeSet = new Set(active);
  return { schemas: stableSchemas, mask: Object.fromEntries(stableSchemas.map(schema => [schema, activeSet.has(schema)])) };
}

export function explainCacheInvalidation(before: CacheStableAssembly, after: CacheStableAssembly): { invalidatedBy: string[]; reusablePrefixChars: number } {
  let reusablePrefixChars = 0;
  const limit = Math.min(before.stablePrefix.length, after.stablePrefix.length);
  while (reusablePrefixChars < limit && before.stablePrefix[reusablePrefixChars] === after.stablePrefix[reusablePrefixChars]) reusablePrefixChars++;
  const invalidatedBy = before.stablePrefix === after.stablePrefix ? [] : before.orderedSegmentIds.filter((id, index) => id !== after.orderedSegmentIds[index]);
  if (invalidatedBy.length === 0 && before.stablePrefix !== after.stablePrefix) {
    const stableIds = before.orderedSegmentIds.filter(id => id !== "turn-evidence");
    invalidatedBy.push(stableIds.find(id => id === "session") ?? stableIds.at(-1) ?? "stable-prefix");
  }
  return { invalidatedBy, reusablePrefixChars };
}
