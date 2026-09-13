/**
 * LruCache - a bounded cache with least-recently-used eviction.
 *
 * DESIGN PATTERNS:
 * - Backed by a Map, which iterates in insertion order. Re-inserting a key on
 *   read moves it to the end, so the first key is always the least recently used
 *
 * WHY LRU AND NOT FIFO:
 * The predecessor package evicted in insertion order at a cap of 50. Once more
 * than 50 runs were live it evicted the entry it was about to read next, so the
 * cache degenerated to a permanent miss while still paying for the stat that
 * populated it. Recency-based eviction keeps the hot entries.
 *
 * AVOID:
 * - Reading through `map.get` directly anywhere; that skips the recency update
 */

const MINIMUM_CAPACITY = 1;

export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < MINIMUM_CAPACITY) {
      throw new Error(`LruCache capacity must be an integer of at least ${MINIMUM_CAPACITY}.`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Read a value, marking it most recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Insert or replace a value, marking it most recently used. */
  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Keys from least to most recently used. Intended for tests and diagnostics. */
  keysFromOldest(): K[] {
    return [...this.entries.keys()];
  }
}
