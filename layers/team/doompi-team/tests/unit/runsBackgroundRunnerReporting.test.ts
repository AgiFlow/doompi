import { beforeEach, describe, expect, it } from 'vitest';

import { RunnerReporting } from '../../src/adapters/runs/background/runnerReporting';
import type { AsyncRunStatus } from '../../src/adapters/runs/background/asyncExecution';
import type { RunResultFile } from '../../src/adapters/resultWatcher';
import type { CoalescedStatusWriterContract } from '../../src/adapters/runs/background/statusWriter';
import type { TerminalTrigger } from '../../src/adapters/runs/background/terminalPersistence';

/**
 * Records every call this test cares about, in the order they actually
 * happen, so the write-order assertion below is about observed call
 * sequence, not about inspecting timer/flush internals.
 */
class RecordingStatusWriter implements CoalescedStatusWriterContract<AsyncRunStatus> {
  calls: string[] = [];
  open(): void {
    this.calls.push('open');
  }
  update(): void {
    this.calls.push('update');
  }
  updateSync(mutator: (status: AsyncRunStatus) => void): void {
    mutator({} as AsyncRunStatus);
    this.calls.push('updateSync');
  }
  appendTool(): void {
    this.calls.push('appendTool');
  }
  appendOutput(): void {
    this.calls.push('appendOutput');
  }
  close(): void {
    this.calls.push('close');
  }
}

/** Exposes the protected `writeResultFile` seam and records order alongside the status writer's calls. */
class TestableRunnerReporting extends RunnerReporting {
  writtenResults: RunResultFile[] = [];
  private readonly sharedCalls: string[];

  constructor(statusWriter: CoalescedStatusWriterContract<AsyncRunStatus>, sharedCalls: string[]) {
    super(statusWriter);
    this.sharedCalls = sharedCalls;
  }

  protected override now(): number {
    return 1_000;
  }

  protected override writeResultFile(_runId: string, result: RunResultFile): void {
    this.sharedCalls.push('writeResultFile');
    this.writtenResults.push(result);
  }
}

function baseStatus(): AsyncRunStatus {
  return {
    runId: 'run-1',
    agent: 'planner',
    state: 'running',
    startedAt: 500,
    lastUpdate: 500,
  };
}

describe('RunnerReporting', () => {
  let calls: string[];
  let statusWriter: RecordingStatusWriter;
  let reporting: TestableRunnerReporting;

  beforeEach(() => {
    calls = [];
    statusWriter = new RecordingStatusWriter();
    // Route the fake writer's own recorded calls into the same array the
    // subclass uses for writeResultFile, so one list gives us the true
    // interleaving of both write sites.
    statusWriter.updateSync = (mutator: (status: AsyncRunStatus) => void) => {
      mutator({} as AsyncRunStatus);
      calls.push('updateSync');
    };
    reporting = new TestableRunnerReporting(statusWriter, calls);
  });

  it('flushes the status write before writing the result file', () => {
    reporting.prepareResult({ success: true, summary: 'done' });

    reporting.mutateTerminalStatus(baseStatus(), undefined);

    expect(calls).toEqual(['updateSync', 'writeResultFile']);
  });

  it('a throw from the result write cannot undo the status flush that already happened', () => {
    reporting = new (class extends TestableRunnerReporting {
      protected override writeResultFile(): never {
        calls.push('writeResultFile-threw');
        throw new Error('disk full');
      }
    })(statusWriter, calls);
    reporting.prepareResult({ success: true, summary: 'done' });

    expect(() => reporting.mutateTerminalStatus(baseStatus(), undefined)).toThrow('disk full');
    // The status flush is the first entry and is unaffected by the later throw.
    expect(calls[0]).toBe('updateSync');
    expect(calls[1]).toBe('writeResultFile-threw');
  });

  it('normal completion with a prepared success result reports canonical state completed', () => {
    reporting.prepareResult({ success: true, summary: 'all good' });
    const status = baseStatus();

    reporting.mutateTerminalStatus(status, undefined);

    expect(status.state).toBe('completed');
    expect(status.endedAt).toBe(1_000);
    expect(status.error).toBeUndefined();
    expect(reporting.writtenResults[0]).toMatchObject({
      runId: 'run-1',
      agent: 'planner',
      success: true,
      state: 'completed',
      summary: 'all good',
      startedAt: 500,
      endedAt: 1_000,
    });
    expect(reporting.writtenResults[0]?.error).toBeUndefined();
  });

  it('normal completion with a prepared failure result reports state failed', () => {
    reporting.prepareResult({ success: false, summary: 'gave up' });
    const status = baseStatus();

    reporting.mutateTerminalStatus(status, undefined);

    expect(status.state).toBe('failed');
    expect(reporting.writtenResults[0]?.success).toBe(false);
    expect(reporting.writtenResults[0]?.summary).toBe('gave up');
  });

  it('uses an explicit stopped state for a controlled operator stop', () => {
    reporting.prepareResult({ success: false, state: 'stopped', summary: 'Stopped before completion.' });
    const status = baseStatus();

    reporting.mutateTerminalStatus(status, undefined);

    expect(status.state).toBe('stopped');
    expect(reporting.writtenResults[0]).toMatchObject({
      success: false,
      state: 'stopped',
      summary: 'Stopped before completion.',
    });
  });

  it('finalizing without ever calling prepareResult() still produces a result, marked failed', () => {
    const status = baseStatus();

    reporting.mutateTerminalStatus(status, undefined);

    expect(status.state).toBe('failed');
    expect(status.error).toBe('Run finalized without ever calling prepareResult().');
    expect(reporting.writtenResults[0]?.success).toBe(false);
    expect(reporting.writtenResults[0]?.summary).toBe('Run finalized without ever calling prepareResult().');
  });

  it('a signal trigger overrides any prepared result and reports state stopped', () => {
    reporting.prepareResult({ success: true, summary: 'was about to finish' });
    const status = baseStatus();
    const trigger: TerminalTrigger = { kind: 'signal', signal: 'SIGTERM' };

    reporting.mutateTerminalStatus(status, trigger);

    expect(status.state).toBe('stopped');
    expect(status.error).toBe('Terminated by signal SIGTERM.');
    expect(reporting.writtenResults[0]?.success).toBe(false);
    // The prepared summary is still used for the result summary even though the trigger decided the state.
    expect(reporting.writtenResults[0]?.summary).toBe('was about to finish');
  });

  it('an uncaughtException trigger reports state failed with the error message', () => {
    const status = baseStatus();
    const trigger: TerminalTrigger = { kind: 'uncaughtException', error: new Error('boom') };

    reporting.mutateTerminalStatus(status, trigger);

    expect(status.state).toBe('failed');
    expect(status.error).toBe('boom');
    expect(reporting.writtenResults[0]?.error).toBe('boom');
  });

  it('an unhandledRejection trigger with an Error reason uses its message', () => {
    const status = baseStatus();
    const trigger: TerminalTrigger = { kind: 'unhandledRejection', reason: new Error('rejected') };

    reporting.mutateTerminalStatus(status, trigger);

    expect(status.error).toBe('rejected');
  });

  it('an unhandledRejection trigger with a string reason uses the string directly', () => {
    const status = baseStatus();
    const trigger: TerminalTrigger = { kind: 'unhandledRejection', reason: 'plain string reason' };

    reporting.mutateTerminalStatus(status, trigger);

    expect(status.error).toBe('plain string reason');
  });

  it('an unhandledRejection trigger with a non-Error, non-string reason falls back to a generic message', () => {
    const status = baseStatus();
    const trigger: TerminalTrigger = { kind: 'unhandledRejection', reason: { weird: true } };

    reporting.mutateTerminalStatus(status, trigger);

    expect(status.error).toBe('Unhandled rejection with no error message.');
  });

  describe("recordSessionFile - what action='resume' will read back", () => {
    it('writes the recorded session file onto status at finalize', () => {
      reporting.recordSessionFile('/sessions/run-1.json');
      reporting.prepareResult({ success: true, summary: 'done' });
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect(status.sessionFile).toBe('/sessions/run-1.json');
    });

    it('omits sessionFile entirely when it was never recorded', () => {
      reporting.prepareResult({ success: true, summary: 'done' });
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect('sessionFile' in status).toBe(false);
    });

    it('drops a session file longer than the bound rather than truncating it into a wrong path', () => {
      const tooLong = `/sessions/${'x'.repeat(5_000)}.json`;
      reporting.recordSessionFile(tooLong);
      reporting.prepareResult({ success: true, summary: 'done' });
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect(status.sessionFile).toBeUndefined();
    });

    it('records regardless of the terminal outcome (a signal-triggered stop still finalizes once)', () => {
      reporting.recordSessionFile('/sessions/run-1.json');
      const status = baseStatus();
      const trigger: TerminalTrigger = { kind: 'signal', signal: 'SIGTERM' };

      reporting.mutateTerminalStatus(status, trigger);

      expect(status.sessionFile).toBe('/sessions/run-1.json');
    });
  });

  it('includes the acceptance ledger in the result when prepareResult() was given one', () => {
    reporting.prepareResult({
      success: true,
      summary: 'done',
      acceptance: { verdict: 'pass', checks: [] } as unknown as NonNullable<
        Parameters<RunnerReporting['prepareResult']>[0]['acceptance']
      >,
    });

    reporting.mutateTerminalStatus(baseStatus(), undefined);

    expect(reporting.writtenResults[0]?.acceptance).toEqual({ verdict: 'pass', checks: [] });
  });

  it('omits the acceptance field entirely when none was prepared', () => {
    reporting.prepareResult({ success: true, summary: 'done' });

    reporting.mutateTerminalStatus(baseStatus(), undefined);

    expect('acceptance' in reporting.writtenResults[0]!).toBe(false);
  });

  describe('summary written into status.json (chain mode reads this, not the result file)', () => {
    it('writes the same summary onto status when it is short', () => {
      reporting.prepareResult({ success: true, summary: 'a short summary' });
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect(status.summary).toBe('a short summary');
      expect(reporting.writtenResults[0]?.summary).toBe('a short summary');
    });

    it('truncates a long summary on status, but leaves the result file summary full-length', () => {
      const longSummary = 'x'.repeat(5_000);
      reporting.prepareResult({ success: true, summary: longSummary });
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect(status.summary!.length).toBeLessThan(longSummary.length);
      expect(status.summary!.length).toBeLessThanOrEqual(4_000);
      expect(status.summary).toMatch(/truncated/);
      expect(reporting.writtenResults[0]?.summary).toBe(longSummary);
      expect((reporting.writtenResults[0]!.summary as string).length).toBe(5_000);
    });

    it('does not truncate a summary exactly at the cap', () => {
      const exactSummary = 'y'.repeat(4_000);
      reporting.prepareResult({ success: true, summary: exactSummary });
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect(status.summary).toBe(exactSummary);
    });

    it('writes the truncated summary onto status even for a fallback (no prepareResult) outcome', () => {
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect(status.summary).toBe('Run finalized without ever calling prepareResult().');
    });

    it('does not include the acceptance ledger on status - only summary is duplicated there', () => {
      reporting.prepareResult({
        success: true,
        summary: 'done',
        acceptance: { verdict: 'pass', checks: [] } as unknown as NonNullable<
          Parameters<RunnerReporting['prepareResult']>[0]['acceptance']
        >,
      });
      const status = baseStatus();

      reporting.mutateTerminalStatus(status, undefined);

      expect('acceptance' in status).toBe(false);
    });
  });
});
