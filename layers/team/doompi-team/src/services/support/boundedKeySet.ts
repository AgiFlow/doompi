/**
 * BoundedKeySet - a "have I already seen this?" set that cannot grow forever.
 *
 * DESIGN PATTERNS:
 * - Insertion-ordered eviction: the oldest key goes when the cap is reached
 *
 * WHY THIS EXISTS:
 * The predecessor package tracked delivered messages, emitted control events and
 * seen request files in plain Sets that were never pruned, so a long session
 * accumulated one entry per event for its whole lifetime. Dedupe only needs a
 * recent window: once an event is old enough to be evicted, the file or record
 * that would have re-triggered it is long gone.
 *
 * AVOID:
 * - Sizing the cap below the number of events that can be in flight at once,
 *   which would let a duplicate slip through
 */

const MINIMUM_CAPACITY = 1;

export class BoundedKeySet<K> {
  private readonly keys = new Set<K>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < MINIMUM_CAPACITY) {
      throw new Error(`BoundedKeySet capacity must be an integer of at least ${MINIMUM_CAPACITY}.`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.keys.size;
  }

  has(key: K): boolean {
    return this.keys.has(key);
  }

  /** Record a key. Returns true when it was newly added. */
  add(key: K): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    while (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next();
      if (oldest.done === true) break;
      this.keys.delete(oldest.value);
    }
    return true;
  }

  delete(key: K): boolean {
    return this.keys.delete(key);
  }

  clear(): void {
    this.keys.clear();
  }
}
