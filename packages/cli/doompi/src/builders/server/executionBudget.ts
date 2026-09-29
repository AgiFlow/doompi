import type { DoomHostExecutionBudget } from '@agimon-ai/doompi-core/packageApi';

const MAX_QUEUED_JOBS = 128;

/** One host owns the queue; session callers only borrow execution slots. */
export function createExecutionBudget(limit = 2): DoomHostExecutionBudget & { close(): void } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Heavy-job limit must be a positive integer');
  let running = 0;
  let closed = false;
  const queue: Array<{ grant(): void; cancel(reason: unknown): void }> = [];

  const drain = (): void => {
    while (!closed && running < limit && queue.length) queue.shift()!.grant();
  };
  const lease = (): (() => void) => {
    running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running--;
      drain();
    };
  };

  return {
    async acquire(signal) {
      if (closed) throw new Error('The host execution budget is closed');
      signal?.throwIfAborted();
      if (running < limit) return lease();
      if (queue.length >= MAX_QUEUED_JOBS) throw new Error('The host heavy-job queue is full');
      return new Promise<() => void>((resolve, reject) => {
        const detach = (): void => signal?.removeEventListener('abort', onAbort);
        const waiter = {
          grant: () => {
            detach();
            if (signal?.aborted) reject(signal.reason);
            else resolve(lease());
          },
          cancel: (reason: unknown) => {
            detach();
            const index = queue.indexOf(waiter);
            if (index >= 0) queue.splice(index, 1);
            reject(reason);
          },
        };
        const onAbort = (): void => waiter.cancel(signal?.reason);
        queue.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    getSnapshot: () => ({ running, queued: queue.length, limit }),
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of queue.splice(0)) waiter.cancel(new Error('The host execution budget is closed'));
    },
  };
}
