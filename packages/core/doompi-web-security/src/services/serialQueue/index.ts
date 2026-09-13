/**
 * Runs async work strictly one at a time, in the order it was handed over.
 *
 * The sealed channel needs this on both directions and it is not an
 * optimisation. Sealing increments a nonce counter and opening enforces that
 * the counter strictly increases, so two overlapping operations are a
 * correctness bug rather than a race worth tolerating: two concurrent seals can
 * resolve out of order and reach the wire with descending counters, and two
 * concurrent opens can advance the high-water mark past a message that has not
 * been read yet, which the receiver then rejects as a replay.
 *
 * Deliberately not a general work pool. A pool with any concurrency above one
 * reintroduces exactly the reordering this exists to prevent.
 */
export interface SerialQueue {
  /** Resolves with the task's result once every task queued before it has settled. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  /** The tail of the chain. Rejections are absorbed so one failure cannot stall the rest. */
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
