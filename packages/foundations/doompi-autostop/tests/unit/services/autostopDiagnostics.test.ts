import { describe, expect, it, vi } from 'vitest';

import { AUTO_STOP_EVENT } from '../../../src/constants/idlePolicy';
import { createAutostopDiagnostics } from '../../../src/services/autostopDiagnostics';
import type { AutostopTelemetrySink } from '../../../src/services/autostopDiagnostics/type';

const WORK = { active: true, items: ['doom-runner:runner-1'], errors: [] };

function createSink(): AutostopTelemetrySink & { recordEvent: ReturnType<typeof vi.fn> } {
  return { recordEvent: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) };
}

describe('autostopDiagnostics', () => {
  it('names the work holding the session open, then throttles repeats', () => {
    const telemetry = createSink();
    let now = 1_000;
    const diagnostics = createAutostopDiagnostics({ telemetry, now: () => now, reportIntervalMs: 60_000 });

    diagnostics.waiting(WORK);
    now += 5_000;
    diagnostics.waiting(WORK);
    now += 55_000;
    diagnostics.waiting(WORK);

    expect(telemetry.recordEvent).toHaveBeenCalledTimes(2);
    expect(telemetry.recordEvent).toHaveBeenNthCalledWith(1, AUTO_STOP_EVENT.waitingOnBackgroundWork, {
      deferral_count: 1,
      waited_ms: 0,
      item_count: 1,
      error_count: 0,
      items: 'doom-runner:runner-1',
      errors: '',
    });
    expect(telemetry.recordEvent.mock.calls[1][1]).toMatchObject({ deferral_count: 3, waited_ms: 60_000 });
  });

  it('reports the total wait when shutdown is finally requested, then starts fresh', () => {
    const telemetry = createSink();
    let now = 0;
    const diagnostics = createAutostopDiagnostics({ telemetry, now: () => now });

    diagnostics.waiting(WORK);
    now = 30_000;
    diagnostics.shutdownRequested();
    diagnostics.waiting(WORK);

    expect(telemetry.recordEvent).toHaveBeenNthCalledWith(2, AUTO_STOP_EVENT.shutdownRequested, {
      deferral_count: 1,
      waited_ms: 30_000,
    });
    expect(telemetry.recordEvent.mock.calls[2][1]).toMatchObject({ deferral_count: 1, waited_ms: 0 });
  });

  it('records a stand-down, the other way an idle session can stay open', () => {
    const telemetry = createSink();
    createAutostopDiagnostics({ telemetry, now: () => 0 }).stoodDown();

    expect(telemetry.recordEvent).toHaveBeenCalledWith(AUTO_STOP_EVENT.stoodDown, {
      deferral_count: 0,
      waited_ms: 0,
      reason: 'pending_messages',
    });
  });

  it('keeps a failing sink from affecting the decision', async () => {
    const telemetry = createSink();
    telemetry.recordEvent.mockRejectedValue(new Error('sink down'));
    const diagnostics = createAutostopDiagnostics({ telemetry, now: () => 0 });

    expect(() => diagnostics.waiting(WORK)).not.toThrow();
    await Promise.resolve();
  });

  it('finishes disposal even when the telemetry flush never answers', async () => {
    vi.useFakeTimers();
    try {
      const telemetry = createSink();
      telemetry.shutdown = vi.fn(() => new Promise<void>(() => undefined));
      const diagnostics = createAutostopDiagnostics({ telemetry, now: () => 0, flushTimeoutMs: 2_000 });
      let finished = false;
      const disposal = diagnostics.dispose().then(() => {
        finished = true;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(finished).toBe(true);
      await disposal;
    } finally {
      vi.useRealTimers();
    }
  });
});
