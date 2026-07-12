export type LruCacheOptions = {
  maxEntries: number;
  ttlMs?: number;
};

type CacheEntry<V> = { value: V; expiresAt?: number };

/** Small dependency-free LRU cache with optional TTL and promise coalescing. */
export class LruCache<K, V> {
  private entries = new Map<K, CacheEntry<V>>();
  private inFlight = new Map<K, Promise<V | null>>();

  constructor(private readonly options: LruCacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) throw new Error("maxEntries must be a positive integer");
  }

  get size(): number { return this.entries.size; }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.options.ttlMs): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: ttlMs === undefined ? undefined : Date.now() + ttlMs });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): boolean { return this.entries.delete(key); }
  clear(): void { this.entries.clear(); }

  async getOrLoad(key: K, load: () => Promise<V | null>): Promise<V | null> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = load();
    this.inFlight.set(key, request);
    try {
      const value = await request;
      if (value !== null) this.set(key, value);
      return value;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
