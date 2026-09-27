import {
  AUTO_STOP_DETAIL_MAX_LENGTH,
  AUTO_STOP_EVENT,
  AUTO_STOP_REPORT_INTERVAL_MS,
  AUTO_STOP_TELEMETRY_FLUSH_MS,
} from '../../constants/idlePolicy';
import type { AutostopDiagnostics, AutostopDiagnosticsOptions, AutostopEventAttributes } from './type';

function detail(values: readonly string[]): string {
  const joined = values.join(', ');
  return joined.length > AUTO_STOP_DETAIL_MAX_LENGTH ? `${joined.slice(0, AUTO_STOP_DETAIL_MAX_LENGTH - 1)}…` : joined;
}

/**
 * Report what an idle session is waiting on before it stops.
 *
 * The first wait is reported at once and a long one again each interval, so a
 * session held open for an hour names the work holding it without flooding
 * the sink every cooldown.
 */
export function createAutostopDiagnostics(options: AutostopDiagnosticsOptions): AutostopDiagnostics {
  const reportIntervalMs = options.reportIntervalMs ?? AUTO_STOP_REPORT_INTERVAL_MS;
  const flushTimeoutMs = options.flushTimeoutMs ?? AUTO_STOP_TELEMETRY_FLUSH_MS;
  let waitStartedAt: number | undefined;
  let lastReportedAt: number | undefined;
  let deferrals = 0;

  const record = (event: string, attributes: AutostopEventAttributes): void => {
    // Diagnostics must never change whether the session stops.
    options.telemetry.recordEvent(event, attributes).catch(() => undefined);
  };
  const waitAttributes = (now: number): AutostopEventAttributes => ({
    deferral_count: deferrals,
    waited_ms: waitStartedAt === undefined ? 0 : now - waitStartedAt,
  });
  const reset = (): void => {
    waitStartedAt = undefined;
    lastReportedAt = undefined;
    deferrals = 0;
  };

  return {
    waiting(work) {
      const now = options.now();
      waitStartedAt ??= now;
      deferrals += 1;
      if (lastReportedAt !== undefined && now - lastReportedAt < reportIntervalMs) return;
      lastReportedAt = now;
      record(AUTO_STOP_EVENT.waitingOnBackgroundWork, {
        ...waitAttributes(now),
        item_count: work.items.length,
        error_count: work.errors.length,
        items: detail(work.items),
        errors: detail(work.errors),
      });
    },
    stoodDown() {
      record(AUTO_STOP_EVENT.stoodDown, { ...waitAttributes(options.now()), reason: 'pending_messages' });
      reset();
    },
    shutdownRequested() {
      record(AUTO_STOP_EVENT.shutdownRequested, waitAttributes(options.now()));
      reset();
    },
    reset,
    async dispose() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        options.telemetry.shutdown().catch(() => undefined),
        new Promise((settle) => {
          timer = setTimeout(settle, flushTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
