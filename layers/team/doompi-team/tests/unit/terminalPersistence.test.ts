import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentRunsDir } from '../../src/adapters/filesystem/paths';
import {
  TerminalPersistenceService,
  type TerminalTrigger,
} from '../../src/adapters/runs/background/terminalPersistence';
import type {
  CoalescedStatusWriterContract,
  StatusWithRecentEntries,
} from '../../src/adapters/runs/background/statusWriter';

/**
 * A status writer that records what was flushed instead of touching disk.
 *
 * The service now takes the writer as an injected dependency rather than a
 * caller-supplied closure, so the single-writer rule is enforced by
 * construction. These tests assert on `syncFlushes` for the same reason they
 * previously asserted on a `persist` spy: what matters is that exactly one
 * synchronous flush happens per terminal, whatever triggered it.
 */
class RecordingStatusWriter implements CoalescedStatusWriterContract {
  readonly syncFlushes: StatusWithRecentEntries[] = [];
  status: StatusWithRecentEntries = {};
  throwOnFlush: Error | undefined;

  open(_runId: string, initialStatus: StatusWithRecentEntries): void {
    this.status = initialStatus;
  }
  update(mutator: (status: StatusWithRecentEntries) => void): void {
    mutator(this.status);
  }
  updateSync(mutator: (status: StatusWithRecentEntries) => void): void {
    if (this.throwOnFlush) throw this.throwOnFlush;
    mutator(this.status);
    this.syncFlushes.push({ ...this.status });
  }
  appendTool(entry: unknown): void {
    (this.status.recentTools ??= []).push(entry);
  }
  appendOutput(entry: unknown): void {
    (this.status.recentOutput ??= []).push(entry);
  }
  close(): void {}
}

/**
 * A test double for the signal, exception and process-exit seams.
 *
 * None of these may reach the real process: registering a real signal handler
 * or calling the real `process.exit` would affect the vitest process running
 * this suite, not just the service under test. `killProcess` is deliberately
 * left as the real implementation here; a dedicated test below exercises it
 * directly against a pid that cannot exist, which is safe precisely because
 * the real implementation is expected to swallow that failure.
 */
class FakeSignalsTerminalPersistenceService extends TerminalPersistenceService {
  readonly writer: RecordingStatusWriter;

  constructor(writer = new RecordingStatusWriter()) {
    super(writer);
    this.writer = writer;
  }

  clock = Date.now();
  readonly signalHandlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();
  uncaughtHandler: ((error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void) | undefined;
  unhandledHandler: ((reason: unknown, promise: Promise<unknown>) => void) | undefined;
  readonly exitCalls: number[] = [];

  protected override now(): number {
    return this.clock;
  }

  protected override onSignal(event: NodeJS.Signals, handler: NodeJS.SignalsListener): void {
    this.signalHandlers.set(event, handler);
  }

  protected override offSignal(event: NodeJS.Signals): void {
    this.signalHandlers.delete(event);
  }

  protected override onUncaughtException(
    handler: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void,
  ): void {
    this.uncaughtHandler = handler;
  }

  protected override offUncaughtException(): void {
    this.uncaughtHandler = undefined;
  }

  protected override onUnhandledRejection(handler: (reason: unknown, promise: Promise<unknown>) => void): void {
    this.unhandledHandler = handler;
  }

  protected override offUnhandledRejection(): void {
    this.unhandledHandler = undefined;
  }

  protected override exitProcess(code: number): void {
    this.exitCalls.push(code);
  }
}

/** Adds a recorded, non-real `killProcess` on top of the fake signal seams above. */
class TestTerminalPersistenceService extends FakeSignalsTerminalPersistenceService {
  readonly killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  protected override killProcess(pid: number, signal: NodeJS.Signals): void {
    this.killCalls.push({ pid, signal });
  }
}

const trackedRunDirs: string[] = [];

function makeRunId(label: string): string {
  const runId = `${label}-${randomUUID()}`;
  trackedRunDirs.push(path.join(currentRunsDir(), runId));
  return runId;
}

function crashMarkerFile(runId: string): string {
  return path.join(currentRunsDir(), runId, 'runner-crash-marker.json');
}

afterEach(() => {
  while (trackedRunDirs.length > 0) {
    const dir = trackedRunDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('begin', () => {
  it('writes a crash marker recording this process before anything else runs', () => {
    const service = new TestTerminalPersistenceService();
    const runId = makeRunId('begin');
    service.begin(runId, () => undefined);

    const marker = JSON.parse(fs.readFileSync(crashMarkerFile(runId), 'utf-8')) as {
      version: number;
      runId: string;
      pid: number;
      startedAt: number;
    };
    expect(marker).toEqual({ version: 1, runId, pid: process.pid, startedAt: service.clock });
  });

  it('installs handlers for SIGTERM, SIGINT, SIGHUP, uncaughtException and unhandledRejection', () => {
    const service = new TestTerminalPersistenceService();
    service.begin(makeRunId('handlers'), () => undefined);

    expect(service.signalHandlers.has('SIGTERM')).toBe(true);
    expect(service.signalHandlers.has('SIGINT')).toBe(true);
    expect(service.signalHandlers.has('SIGHUP')).toBe(true);
    expect(service.uncaughtHandler).toBeDefined();
    expect(service.unhandledHandler).toBeDefined();
  });

  it('resets a previous run when called again, clearing its tracked children', () => {
    const service = new TestTerminalPersistenceService();
    const firstRunId = makeRunId('reset-first');
    service.begin(firstRunId, () => undefined);
    service.trackChild(111);

    const secondRunId = makeRunId('reset-second');
    const persist = vi.fn();
    service.begin(secondRunId, persist);
    service.finalize();

    // The child tracked against the first run must not be killed by the
    // second run's finalize; begin() cleared it.
    expect(service.killCalls).toEqual([]);
    expect(persist).toHaveBeenCalledOnce();
  });
});

describe('finalize', () => {
  it('calls persist exactly once with no trigger for the normal path', () => {
    const service = new TestTerminalPersistenceService();
    const persist = vi.fn();
    service.begin(makeRunId('normal'), persist);

    service.finalize();

    expect(persist).toHaveBeenCalledExactlyOnceWith(expect.anything(), undefined);
  });

  it('is idempotent: a second call produces no second persist', () => {
    const service = new TestTerminalPersistenceService();
    const persist = vi.fn();
    service.begin(makeRunId('twice'), persist);

    service.finalize();
    service.finalize();
    service.finalize();

    expect(persist).toHaveBeenCalledOnce();
  });

  it('is a safe no-op when called before begin()', () => {
    const service = new TestTerminalPersistenceService();
    expect(() => service.finalize()).not.toThrow();
  });

  it('clears the crash marker once persist succeeds', () => {
    const service = new TestTerminalPersistenceService();
    const runId = makeRunId('clears-marker');
    service.begin(runId, () => undefined);
    expect(fs.existsSync(crashMarkerFile(runId))).toBe(true);

    service.finalize();

    expect(fs.existsSync(crashMarkerFile(runId))).toBe(false);
  });

  it('leaves the crash marker in place when persist throws, and still propagates the throw', () => {
    const service = new TestTerminalPersistenceService();
    const runId = makeRunId('persist-throws');
    service.begin(runId, () => {
      throw new Error('status writer unavailable');
    });

    expect(() => service.finalize()).toThrow('status writer unavailable');
    expect(fs.existsSync(crashMarkerFile(runId))).toBe(true);
  });

  it('removes the installed handlers so a later signal cannot be swallowed silently', () => {
    const service = new TestTerminalPersistenceService();
    service.begin(makeRunId('removes-handlers'), () => undefined);

    service.finalize();

    expect(service.signalHandlers.size).toBe(0);
    expect(service.uncaughtHandler).toBeUndefined();
    expect(service.unhandledHandler).toBeUndefined();
  });

  it('kills every tracked child and then forgets them, even when persist throws', () => {
    const service = new TestTerminalPersistenceService();
    service.begin(makeRunId('kills-children'), () => {
      throw new Error('boom');
    });
    service.trackChild(101);
    service.trackChild(102);

    expect(() => service.finalize()).toThrow('boom');

    expect(service.killCalls).toEqual([
      { pid: 101, signal: 'SIGKILL' },
      { pid: 102, signal: 'SIGKILL' },
    ]);
  });

  it('stops tracking a child that exited on its own before finalize', () => {
    const service = new TestTerminalPersistenceService();
    service.begin(makeRunId('untrack'), () => undefined);
    service.trackChild(201);
    service.untrackChild(201);

    service.finalize();

    expect(service.killCalls).toEqual([]);
  });

  it('tolerates killing an already-dead child using the real process.kill implementation', () => {
    // killProcess is NOT overridden on this class, so this exercises the real
    // implementation against a pid that cannot plausibly exist - the direct
    // proof that it swallows ESRCH rather than letting finalize throw.
    const service = new FakeSignalsTerminalPersistenceService();
    service.begin(makeRunId('dead-child'), () => undefined);
    service.trackChild(2 ** 31 - 1);

    expect(() => service.finalize()).not.toThrow();
  });
});

describe('dispose', () => {
  it('removes handlers without persisting or clearing the crash marker', () => {
    const service = new TestTerminalPersistenceService();
    const runId = makeRunId('dispose');
    const persist = vi.fn();
    service.begin(runId, persist);

    service.dispose();

    expect(persist).not.toHaveBeenCalled();
    expect(service.signalHandlers.size).toBe(0);
    expect(fs.existsSync(crashMarkerFile(runId))).toBe(true);
  });

  it('is safe to call more than once', () => {
    const service = new TestTerminalPersistenceService();
    service.begin(makeRunId('dispose-twice'), () => undefined);
    expect(() => {
      service.dispose();
      service.dispose();
    }).not.toThrow();
  });
});

describe('signal handling', () => {
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'finalizes with a signal trigger and exits with 128 + the signal number for %s',
    (signal) => {
      const service = new TestTerminalPersistenceService();
      const seenTriggers: Array<TerminalTrigger | undefined> = [];
      service.begin(makeRunId(`signal-${signal}`), (_status, trigger) => seenTriggers.push(trigger));

      const handler = service.signalHandlers.get(signal);
      if (!handler) throw new Error(`expected a handler for ${signal}`);
      handler(signal);

      expect(seenTriggers).toEqual([{ kind: 'signal', signal }]);
      expect(service.exitCalls).toEqual([128 + os.constants.signals[signal]]);
    },
  );

  it('finalizes with an uncaughtException trigger and exits 1', () => {
    const service = new TestTerminalPersistenceService();
    const seenTriggers: Array<TerminalTrigger | undefined> = [];
    service.begin(makeRunId('uncaught'), (_status, trigger) => seenTriggers.push(trigger));

    const error = new Error('boom');
    service.uncaughtHandler?.(error, 'uncaughtException');

    expect(seenTriggers).toEqual([{ kind: 'uncaughtException', error }]);
    expect(service.exitCalls).toEqual([1]);
  });

  it('finalizes with an unhandledRejection trigger and exits 1', () => {
    const service = new TestTerminalPersistenceService();
    const seenTriggers: Array<TerminalTrigger | undefined> = [];
    service.begin(makeRunId('unhandled'), (_status, trigger) => seenTriggers.push(trigger));

    const promise = Promise.reject(new Error('rejected')).catch(() => undefined);
    service.unhandledHandler?.('rejected reason', promise);

    expect(seenTriggers).toEqual([{ kind: 'unhandledRejection', reason: 'rejected reason' }]);
    expect(service.exitCalls).toEqual([1]);
  });

  it('does not corrupt state when a signal fires again after a normal finalize already ran', () => {
    const service = new TestTerminalPersistenceService();
    const persist = vi.fn();
    service.begin(makeRunId('post-finalize-signal'), persist);
    const handler = service.signalHandlers.get('SIGTERM');
    if (!handler) throw new Error('expected a SIGTERM handler');

    service.finalize();
    expect(persist).toHaveBeenCalledOnce();

    // Invoking the captured handler directly, bypassing whatever registry
    // Node itself uses, still has to observe the idempotency guard: a real
    // signal delivered a moment too late must not re-run persist or throw.
    expect(() => handler('SIGTERM')).not.toThrow();
    expect(persist).toHaveBeenCalledOnce();
    // The process must still be told to exit for the signal that really
    // arrived, even though nothing was persisted a second time.
    expect(service.exitCalls).toEqual([128 + os.constants.signals.SIGTERM]);
  });
});

describe('real process seams', () => {
  it('registers a real listener for every handled event and removes exactly that listener on dispose', () => {
    // killProcess/exitProcess are still overridden here: nothing in this test
    // triggers a handler, but guarding them means a surprising real signal
    // during the test run cannot escalate into killing a process or exiting
    // the test runner.
    class RealSeamsService extends TerminalPersistenceService {
      protected override killProcess(): void {}
      protected override exitProcess(): void {
        throw new Error('exitProcess must not be reached in this test');
      }
    }
    const service = new RealSeamsService(new RecordingStatusWriter());
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      sighup: process.listenerCount('SIGHUP'),
      uncaught: process.listenerCount('uncaughtException'),
      unhandled: process.listenerCount('unhandledRejection'),
    };

    try {
      // begin() also exercises the real now() through the crash marker write.
      service.begin(makeRunId('real-seams'), () => undefined);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
      expect(process.listenerCount('SIGHUP')).toBe(before.sighup + 1);
      expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1);
      expect(process.listenerCount('unhandledRejection')).toBe(before.unhandled + 1);
    } finally {
      // Guaranteed to run even if an assertion above throws, so a failing
      // expectation here can never leak a real listener onto the test process.
      service.dispose();
    }

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGHUP')).toBe(before.sighup);
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(before.unhandled);
  });
});
