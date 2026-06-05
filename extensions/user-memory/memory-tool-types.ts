import type { EntityStore } from "./entity.js";
import type { Memory, MemoryStore } from "./store.js";
import type { RememberParams as WizardRememberParams } from "./types.js";

export type MemoryHit = { memory: Memory; score: number };

export type MemoryToolDeps = {
  ensureLoaded: () => Promise<void>;
  getStore: () => MemoryStore;
  getEntityStore: () => EntityStore;
  rememberStructuredMemory: (params: WizardRememberParams) => Promise<any>;
  hybridSearch: (query: string, topK: number, filterFn?: (m: Memory) => boolean) => Promise<MemoryHit[]>;
  persist: () => Promise<void>;
  removeFromIndexes: (id: string) => void;
  reindexMemory: (mem: Memory) => void;
  age: (ts: number) => string;
};
