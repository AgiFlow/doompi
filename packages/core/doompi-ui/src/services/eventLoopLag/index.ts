/** How often the sampler asks to be woken. Short enough to catch a stall inside a single tool call. */
const SAMPLE_INTERVAL_MS = 250;
/**
 * Below this, a late timer is ordinary scheduling jitter rather than something a
 * user would feel. Reporting every sample would cost more than it measures.
 */
const REPORT_THRESHOLD_MS = 250;

export interface EventLoopLagSampler {
  stop(): void;
}

/**
 * Reports how far behind schedule the event loop is running.
 *
 * A timer that wakes late is the only signal from inside the process that
 * something synchronous, garbage collection included, held the loop. Nothing in
 * a session transcript records it, so a stall here is otherwise invisible and
 * reads as a slow model or a slow tool.
 */
export function startEventLoopLagSampler(report: (lagMs: number) => void): EventLoopLagSampler {
  let expected = Date.now() + SAMPLE_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - expected;
    // Rebased on the wake that just happened rather than advanced by a fixed
    // step, so one long stall does not report itself again on every later tick.
    expected = now + SAMPLE_INTERVAL_MS;
    if (lagMs >= REPORT_THRESHOLD_MS) report(lagMs);
  }, SAMPLE_INTERVAL_MS);
  // A diagnostic must never be the reason a process refuses to exit.
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
