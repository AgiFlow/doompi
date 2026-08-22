import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoalescedStatusWriter, type StatusWithRecentEntries } from '../../src/adapters/runs/background/statusWriter';
import { currentRunsDir } from '../../src/adapters/filesystem/paths';

interface FakeRunStatus extends StatusWithRecentEntries {
  state: 'running' | 'completed' | 'failed';
  currentStep: number;
}

/**
 * Counts calls to the protected `clone()` seam.
 *
 * This is the only direct way to observe the dirty-counter gate: every real
 * flush clones exactly once before writing, so counting clones is counting
 * flushes that actually did something.
 */
class CountingStatusWriter<TStatus extends StatusWithRecentEntries> extends CoalescedStatusWriter<TStatus> {
  cloneCalls = 0;

  protected override clone<T>(value: T): T {
    this.cloneCalls++;
    return super.clone(value);
  }
}

const createdRunIds: string[] = [];

function freshRunId(label: string): string {
  const runId = `status-writer-${label}-${Math.random().toString(36).slice(2)}`;
  createdRunIds.push(runId);
  return runId;
}

function statusPathFor(runId: string): string {
  return path.join(currentRunsDir(), runId, 'status.json');
}

function readStatus(runId: string): FakeRunStatus {
  return JSON.parse(fs.readFileSync(statusPathFor(runId), 'utf-8')) as FakeRunStatus;
}

function newWriter(): CountingStatusWriter<FakeRunStatus> {
  return new CountingStatusWriter<FakeRunStatus>();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  while (createdRunIds.length > 0) {
    const runId = createdRunIds.pop();
    if (runId) fs.rmSync(path.join(currentRunsDir(), runId), { recursive: true, force: true });
  }
});

describe('CoalescedStatusWriter.open', () => {
  it('writes the initial status synchronously, so the file exists before open() returns', () => {
    const runId = freshRunId('open');
    const writer = newWriter();

    writer.open(runId, { state: 'running', currentStep: 0 });

    expect(readStatus(runId)).toEqual({ state: 'running', currentStep: 0 });
  });
});

describe('CoalescedStatusWriter.open called again', () => {
  it('resets tracked state instead of erroring, discarding an unflushed mutation from the prior session', () => {
    const firstRunId = freshRunId('reopen-first');
    const secondRunId = freshRunId('reopen-second');
    const writer = newWriter();
    writer.open(firstRunId, { state: 'running', currentStep: 0 });

    // Buffered but never flushed: a retried bootstrap must not resurrect this.
    writer.update((status) => {
      status.currentStep = 99;
    });

    writer.open(secondRunId, { state: 'running', currentStep: 0 });
    vi.advanceTimersByTime(200);

    expect(readStatus(secondRunId)).toEqual({ state: 'running', currentStep: 0 });
    // The first run's file was never touched again after the discarded update.
    expect(readStatus(firstRunId)).toEqual({ state: 'running', currentStep: 0 });
  });

  it('cancels the pending coalescing timer from the prior session, so it cannot flush into the new one', () => {
    const firstRunId = freshRunId('reopen-timer-first');
    const secondRunId = freshRunId('reopen-timer-second');
    const writer = newWriter();
    writer.open(firstRunId, { state: 'running', currentStep: 0 });
    writer.update((status) => {
      status.currentStep = 1;
    });
    writer.cloneCalls = 0;

    writer.open(secondRunId, { state: 'completed', currentStep: 0 });
    vi.advanceTimersByTime(200);

    // Only open()'s own synchronous write for the second session; the first
    // session's timer, if it had fired, would have produced an extra clone.
    expect(writer.cloneCalls).toBe(1);
  });
});

describe('CoalescedStatusWriter.update', () => {
  it('buffers a mutation in memory instead of writing it immediately', () => {
    const runId = freshRunId('buffer');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });

    writer.update((status) => {
      status.currentStep = 1;
    });

    expect(readStatus(runId).currentStep).toBe(0);
  });

  it('flushes a buffered mutation once the trailing coalescing timer elapses', () => {
    const runId = freshRunId('flush');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });

    writer.update((status) => {
      status.currentStep = 1;
    });
    vi.advanceTimersByTime(75);

    expect(readStatus(runId).currentStep).toBe(1);
  });

  it('coalesces a burst of updates inside the window into a single clone and a single write', () => {
    const runId = freshRunId('coalesce');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });
    writer.cloneCalls = 0; // open() clones once for its own synchronous write; ignore that here.

    for (let step = 1; step <= 5; step++) {
      writer.update((status) => {
        status.currentStep = step;
      });
    }
    vi.advanceTimersByTime(75);

    // This is the fix for the predecessor's quadratic behaviour: five events
    // inside one window cost one clone, not five.
    expect(writer.cloneCalls).toBe(1);
    expect(readStatus(runId).currentStep).toBe(5);
  });

  it('performs zero clones across repeated flushes once nothing has changed since the last one', () => {
    const runId = freshRunId('no-op');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });
    writer.cloneCalls = 0;

    writer.update((status) => {
      status.currentStep = 1;
    });
    vi.advanceTimersByTime(75);
    expect(writer.cloneCalls).toBe(1);

    // Nothing dirtied the status since that flush. close() flushes again on
    // every call, and must not reclone or rewrite an unchanged status.
    writer.close();
    writer.close();
    writer.close();

    expect(writer.cloneCalls).toBe(1);
  });

  it('throws rather than silently discarding a mutation made before open()', () => {
    const writer = newWriter();

    expect(() =>
      writer.update(() => {
        /* never reached */
      }),
    ).toThrow(/before open/);
  });
});

describe('CoalescedStatusWriter.updateSync', () => {
  it('writes a terminal transition to disk before returning, without waiting for the coalescing timer', () => {
    const runId = freshRunId('sync');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });

    writer.updateSync((status) => {
      status.state = 'completed';
    });

    expect(readStatus(runId).state).toBe('completed');
  });

  it('cancels a pending coalesced flush, so the sync write is not duplicated when the timer would have fired', () => {
    const runId = freshRunId('sync-cancel');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });
    writer.cloneCalls = 0;

    writer.update((status) => {
      status.currentStep = 1;
    });
    writer.updateSync((status) => {
      status.state = 'completed';
    });
    vi.advanceTimersByTime(200);

    // One clone for the sync flush; the timer it preempted must not add a second.
    expect(writer.cloneCalls).toBe(1);
  });
});

describe('CoalescedStatusWriter recentTools / recentOutput capping', () => {
  it('caps recentTools at 50 entries, dropping the oldest first', () => {
    const runId = freshRunId('tools-cap');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });

    for (let i = 0; i < 60; i++) writer.appendTool({ tool: `tool-${i}` });
    vi.advanceTimersByTime(75);

    const recentTools = readStatus(runId).recentTools as Array<{ tool: string }>;
    expect(recentTools).toHaveLength(50);
    expect(recentTools[0]).toEqual({ tool: 'tool-10' });
    expect(recentTools[49]).toEqual({ tool: 'tool-59' });
  });

  it('caps recentOutput at 50 entries the same way, so a long run cannot grow the status file without bound', () => {
    const runId = freshRunId('output-cap');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });

    for (let i = 0; i < 55; i++) writer.appendOutput(`line-${i}`);
    vi.advanceTimersByTime(75);

    const recentOutput = readStatus(runId).recentOutput as string[];
    expect(recentOutput).toHaveLength(50);
    expect(recentOutput[0]).toBe('line-5');
    expect(recentOutput[49]).toBe('line-54');
  });
});

describe('CoalescedStatusWriter.close', () => {
  it('flushes a dirty buffered mutation instead of losing it on shutdown', () => {
    const runId = freshRunId('close-flush');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });

    writer.update((status) => {
      status.currentStep = 1;
    });
    writer.close();

    expect(readStatus(runId).currentStep).toBe(1);
  });

  it('is safe to call when nothing is buffered', () => {
    const runId = freshRunId('close-idle');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });
    writer.cloneCalls = 0;

    expect(() => writer.close()).not.toThrow();
    expect(writer.cloneCalls).toBe(0);
  });
});

describe('CoalescedStatusWriter timer lifecycle', () => {
  it('unrefs the coalescing timer, so a pending flush cannot keep the process alive', () => {
    vi.useRealTimers();
    const runId = freshRunId('unref');
    const writer = newWriter();
    writer.open(runId, { state: 'running', currentStep: 0 });

    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementationOnce((handler: (...args: unknown[]) => void, ms?: number) => {
        void handler;
        void ms;
        return { unref, ref: vi.fn(), hasRef: () => false } as unknown as NodeJS.Timeout;
      });

    writer.update((status) => {
      status.currentStep = 1;
    });

    expect(unref).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
    vi.useFakeTimers();
  });
});
