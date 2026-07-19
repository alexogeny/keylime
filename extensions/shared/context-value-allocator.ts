export type ContextValueItem = { id: string; category: string; chars: number; relevance: number; impact: number; freshness: number; confidence: number; lossRisk: number; recoverable: boolean; mandatory?: boolean };
export type ContextAllocationOptions = { maxChars: number; categoryFloors?: Record<string, number> };
export type ContextAllocation = { selected: ContextValueItem[]; rejected: ContextValueItem[]; totalChars: number; scores: Record<string, number>; categoryChars: Record<string, number> };

function value(item: ContextValueItem): number {
  const utility = .3 * item.relevance + .25 * item.impact + .1 * item.freshness + .1 * item.confidence + .25 * item.lossRisk;
  const recoveryFactor = item.recoverable ? .72 : 1;
  return utility * recoveryFactor / Math.max(1, item.chars);
}

export function allocateContextBudget(items: ContextValueItem[], options: ContextAllocationOptions): ContextAllocation {
  const ordered = [...items].sort((a, b) => Number(Boolean(b.mandatory)) - Number(Boolean(a.mandatory)) || value(b) - value(a) || a.id.localeCompare(b.id));
  const selected: ContextValueItem[] = [];
  const selectedIds = new Set<string>();
  let totalChars = 0;
  const add = (item: ContextValueItem): void => {
    if (selectedIds.has(item.id) || totalChars + item.chars > options.maxChars) return;
    selected.push(item); selectedIds.add(item.id); totalChars += item.chars;
  };
  for (const item of ordered.filter(item => item.mandatory)) add(item);
  for (const [category, floor] of Object.entries(options.categoryFloors ?? {})) {
    let categoryChars = selected.filter(item => item.category === category).reduce((sum, item) => sum + item.chars, 0);
    for (const item of ordered.filter(item => item.category === category)) {
      if (categoryChars >= floor) break;
      const before = totalChars; add(item); if (totalChars > before) categoryChars += item.chars;
    }
  }
  for (const item of ordered) add(item);
  const categoryChars: Record<string, number> = {};
  for (const item of selected) categoryChars[item.category] = (categoryChars[item.category] ?? 0) + item.chars;
  return {
    selected,
    rejected: ordered.filter(item => !selectedIds.has(item.id)),
    totalChars,
    scores: Object.fromEntries(items.map(item => [item.id, value(item)])),
    categoryChars,
  };
}
