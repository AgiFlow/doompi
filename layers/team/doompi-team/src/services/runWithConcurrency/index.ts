/**
 * Runs a batch of async operations with at most N in flight at once, and
 * always settles all of them - one rejection never aborts its peers.
 *
 * WHY THIS EXISTS, RATHER THAN BEING INLINED INTO ITS ONE CALLER:
 * `spawnPlan.ts`'s PARALLEL mode needs exactly this shape (fire up to
 * `concurrency` tasks at once, wait for a slot to free before starting the
 * next, return every outcome regardless of individual failure), and it is a
 * property worth testing directly rather than only through spawn-plan's own
 * fixtures: "at most N in flight at any moment" and "one rejection does not
 * abort its peers" are each independently verifiable here, which is more
 * precise than inferring them from a higher-level test that also exercises
 * agent resolution, depth checks, and status writes.
 *
 * DELIBERATELY MINIMAL:
 * Bounded concurrency and settle-all, nothing else - no priority ordering
 * beyond FIFO start order, no cancellation, no `AbortSignal`. Reporting is
 * injected by the caller so this host-neutral helper never creates a telemetry
 * resource that it cannot shut down.
 */

export type ConcurrencyEventReporter = (event: string, attributes: Record<string, unknown>) => void;

export type ConcurrencyOutcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/**
 * Runs `factories` (each called at most once, lazily, only once a slot is
 * free) with at most `concurrency` in flight at a time. Resolves once every
 * factory has settled, in the SAME ORDER as `factories` regardless of which
 * one finished first - a caller zipping results back against its own input
 * list does not need to track indices itself.
 */
export async function runWithConcurrency<T>(
  factories: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
  report?: ConcurrencyEventReporter,
): Promise<ConcurrencyOutcome<T>[]> {
  const startedAt = Date.now();
  const results: ConcurrencyOutcome<T>[] = Array.from({ length: factories.length });
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, factories.length || 1));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= factories.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await factories[index]!() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  report?.('doom_team.concurrency_started', {
    'team.task_count': factories.length,
    'team.concurrency': effectiveConcurrency,
  });
  await Promise.all(Array.from({ length: effectiveConcurrency }, () => worker()));
  report?.('doom_team.concurrency_finished', {
    'team.task_count': factories.length,
    'team.concurrency': effectiveConcurrency,
    'team.failure_count': results.filter((result) => result?.status === 'rejected').length,
    duration_ms: Date.now() - startedAt,
    outcome: 'completed',
  });
  return results;
}
