import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { RunnerExecution } from '../../src/adapters/runs/background/runnerExecution';
import { runDirFor, type AsyncRunStatus } from '../../src/adapters/runs/background/asyncExecution';
import type {
  ControlChannelWatchHandlers,
  ControlChannelWatchOptions,
  ControlChannelWatcherContract,
} from '../../src/adapters/intercom/supervisorControlChannel';
import type { RunnerReportingContract, RunnerResultInput } from '../../src/adapters/runs/background/runnerReporting';
import type { CoalescedStatusWriterContract } from '../../src/adapters/runs/background/statusWriter';
import type { TerminalPersistenceContract } from '../../src/adapters/runs/background/terminalPersistence';

class FakeControlChannel implements ControlChannelWatcherContract {
  watchCalls: Array<{ asyncDir: string; handlers: ControlChannelWatchHandlers }> = [];
  disposeCalls = 0;
  watch(asyncDir: string, handlers: ControlChannelWatchHandlers, _options?: ControlChannelWatchOptions): () => void {
    this.watchCalls.push({ asyncDir, handlers });
    return () => {
      this.disposeCalls += 1;
    };
  }
}

/**
 * A fake, not a reimplementation of the real idempotency guarantee - the
 * point of these tests is that `RunnerExecution` funnels every trigger
 * through this ONE `finalize()`, not that finalize itself is idempotent
 * (that guarantee is `TerminalPersistenceService`'s own, covered by its own
 * tests).
 */
class FakeTerminalPersistence implements TerminalPersistenceContract {
  finalizeCallCount = 0;
  finalizeError: Error | undefined;
  begin(): void {}
  trackChild(): void {}
  untrackChild(): void {}
  finalize(): void {
    this.finalizeCallCount += 1;
    if (this.finalizeError) throw this.finalizeError;
  }
  dispose(): void {}
}

class FakeReporting implements RunnerReportingContract {
  prepareCalls: RunnerResultInput[] = [];
  prepareResult(input: RunnerResultInput): void {
    this.prepareCalls.push(input);
  }
  mutateTerminalStatus(): void {}
  recordSessionFile(sessionFile: string): string {
    return sessionFile;
  }
}

class TestRunnerExecution extends RunnerExecution {
  readonly exitCodes: number[] = [];

  protected override exitProcess(code: number): void {
    this.exitCodes.push(code);
  }
}

class FakeStatusWriter implements CoalescedStatusWriterContract<AsyncRunStatus> {
  updateMutators: Array<(status: AsyncRunStatus) => void> = [];
  /** The status object every `update()` mutator is applied to, so a test can inspect the cumulative result. */
  status: AsyncRunStatus = {} as AsyncRunStatus;
  open(): void {}
  update(mutator: (status: AsyncRunStatus) => void): void {
    this.updateMutators.push(mutator);
    mutator(this.status);
  }
  updateSync(): void {}
  appendTool(): void {}
  appendOutput(): void {}
  close(): void {}
}

/** A guard whose next `evaluate()` result is fully controlled. */
const temporaryDirs: string[] = [];

function makeRunDir(runId: string): string {
  const dir = runDirFor(runId);
  fs.mkdirSync(dir, { recursive: true });
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeExecution() {
  const controlChannel = new FakeControlChannel();
  const terminalPersistence = new FakeTerminalPersistence();
  const reporting = new FakeReporting();
  const statusWriter = new FakeStatusWriter();
  const execution = new TestRunnerExecution(controlChannel, terminalPersistence, reporting, statusWriter);
  return { controlChannel, terminalPersistence, reporting, statusWriter, execution };
}

describe('RunnerExecution', () => {
  it('coalesces live progress fields and preserves observed zero values', () => {
    const { execution, statusWriter } = makeExecution();

    execution.setProgress({ tokens: 0, currentTool: 'Read', toolCount: 0 });

    expect(statusWriter.status).toMatchObject({ tokens: 0, currentTool: 'Read', toolCount: 0 });
    expect(statusWriter.updateMutators).toHaveLength(1);
  });

  it('does not persist a token field when progress has no token observation', () => {
    const { execution, statusWriter } = makeExecution();

    execution.setProgress({ currentTool: 'Read', toolCount: 0 });

    expect(statusWriter.status).not.toHaveProperty('tokens');
    expect(statusWriter.status).toMatchObject({ currentTool: 'Read', toolCount: 0 });
  });

  describe('every terminal trigger routes through the same finalize()', () => {
    it('complete() prepares a result and calls finalize() exactly once', () => {
      const { terminalPersistence, reporting, execution } = makeExecution();

      execution.complete(true, 'all done');

      expect(reporting.prepareCalls).toEqual([{ success: true, summary: 'all done' }]);
      expect(terminalPersistence.finalizeCallCount).toBe(1);
    });

    it('interrupt() prepares its own result and calls the SAME finalize()', () => {
      const { terminalPersistence, reporting, execution } = makeExecution();

      execution.interrupt();

      expect(reporting.prepareCalls).toEqual([{ success: false, summary: 'Interrupted before completion.' }]);
      expect(terminalPersistence.finalizeCallCount).toBe(1);
    });

    it('stop() prepares its own result and calls the SAME finalize()', () => {
      const { terminalPersistence, reporting, execution } = makeExecution();

      execution.stop();

      expect(reporting.prepareCalls).toEqual([
        { success: false, state: 'stopped', summary: 'Stopped before completion.' },
      ]);
      expect(terminalPersistence.finalizeCallCount).toBe(1);
      expect(execution.exitCodes).toEqual([0]);
    });

    it('exits even when stop persistence fails', () => {
      const { terminalPersistence, execution } = makeExecution();
      terminalPersistence.finalizeError = new Error('disk full');

      expect(() => execution.stop()).toThrow('disk full');

      expect(execution.exitCodes).toEqual([0]);
    });

    it('timeout() prepares its own result and calls the SAME finalize()', () => {
      const { terminalPersistence, reporting, execution } = makeExecution();

      execution.timeout();

      expect(reporting.prepareCalls).toEqual([{ success: false, summary: 'Timed out before completion.' }]);
      expect(terminalPersistence.finalizeCallCount).toBe(1);
    });

    it("a stray extra trigger after one already fired still just calls finalize() again - idempotency itself is TerminalPersistenceService's job, not a second local guard here", () => {
      const { terminalPersistence, execution } = makeExecution();

      execution.complete(true, 'done');
      execution.stop(); // e.g. a stray control event racing the completion tail

      // RunnerExecution does not add its own re-entry guard - both calls go
      // through, exactly as designed. What matters is neither of them wrote
      // status/result directly; the real idempotency guard lives in
      // TerminalPersistenceService.finalize() itself, verified separately.
      expect(terminalPersistence.finalizeCallCount).toBe(2);
    });
  });

  describe('start()', () => {
    it("wires interrupt/stop/timeout handlers into the control channel watch for this run's directory", () => {
      const runId = 'run-start';
      makeRunDir(runId);
      const { controlChannel, terminalPersistence, execution } = makeExecution();

      const dispose = execution.start(runId);

      expect(controlChannel.watchCalls).toHaveLength(1);
      expect(controlChannel.watchCalls[0]?.asyncDir).toBe(runDirFor(runId));
      const handlers = controlChannel.watchCalls[0]!.handlers;

      handlers.onInterrupt();
      expect(terminalPersistence.finalizeCallCount).toBe(1);
      handlers.onStop?.();
      expect(terminalPersistence.finalizeCallCount).toBe(2);
      handlers.onTimeout?.();
      expect(terminalPersistence.finalizeCallCount).toBe(3);

      dispose();
      expect(controlChannel.disposeCalls).toBe(1);
    });

    it('forwards onSteer through untouched when a handler is supplied', () => {
      const runId = 'run-steer';
      makeRunDir(runId);
      const { controlChannel, execution } = makeExecution();
      const steerCalls: unknown[] = [];

      execution.start(runId, { onSteer: (request) => steerCalls.push(request) });

      const handlers = controlChannel.watchCalls[0]!.handlers;
      const request = { type: 'steer' as const, id: 's-1', ts: 1, message: 'go left' };
      handlers.onSteer?.(request);

      expect(steerCalls).toEqual([request]);
    });
  });
});
