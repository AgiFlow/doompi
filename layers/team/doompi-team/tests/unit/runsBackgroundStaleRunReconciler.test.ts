import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { steerRequestsDir } from '../../src/adapters/intercom/supervisorControlChannel';
import type { ProcessTerminalInspectorContract, ProcessTerminalVerdict } from '../../src/adapters/processTerminal';
import type { RunIdResolverContract, ResolvedRunLocation } from '../../src/adapters/runIdResolver';
import { type ReconcilableStatus, StaleRunReconciler } from '../../src/adapters/staleRunReconciler';
import type { CoalescedStatusWriterContract } from '../../src/adapters/runs/background/statusWriter';
import { currentRunsDir } from '../../src/adapters/filesystem/paths';

/** A status writer that records what was opened and flushed instead of touching disk. */
class RecordingStatusWriter implements CoalescedStatusWriterContract<ReconcilableStatus> {
  opened: { runId: string; initialStatus: ReconcilableStatus } | undefined;
  status: ReconcilableStatus = {};
  readonly syncFlushes: ReconcilableStatus[] = [];

  open(runId: string, initialStatus: ReconcilableStatus): void {
    // Snapshot what was seen at open() time: `status` below is mutated in
    // place by updateSync(), and it is the same reference `open()` was given.
    this.opened = { runId, initialStatus: { ...initialStatus } };
    this.status = initialStatus;
  }
  update(mutator: (status: ReconcilableStatus) => void): void {
    mutator(this.status);
  }
  updateSync(mutator: (status: ReconcilableStatus) => void): void {
    mutator(this.status);
    this.syncFlushes.push({ ...this.status });
  }
  appendTool(entry: unknown): void {
    this.status.recentTools ??= [];
    this.status.recentTools.push(entry);
  }
  appendOutput(entry: unknown): void {
    this.status.recentOutput ??= [];
    this.status.recentOutput.push(entry);
  }
  close(): void {}
}

/** A process terminal inspector whose verdict for the next `inspect()` call is fully controlled. */
class FakeProcessTerminalInspector implements ProcessTerminalInspectorContract {
  verdict: ProcessTerminalVerdict = { state: 'unknown', marker: undefined };
  calls: string[] = [];

  inspect(runId: string): ProcessTerminalVerdict {
    this.calls.push(runId);
    return this.verdict;
  }

  async inspectAsync(runId: string): Promise<ProcessTerminalVerdict> {
    return this.inspect(runId);
  }
}

/** A run id resolver whose result location for the next `resolve()` call is fully controlled. */
class FakeRunIdResolver implements RunIdResolverContract {
  location: ResolvedRunLocation | undefined;
  calls: string[] = [];

  resolve(id: string): ResolvedRunLocation | undefined {
    this.calls.push(id);
    return this.location;
  }

  async resolveAsync(id: string): Promise<ResolvedRunLocation | undefined> {
    return this.resolve(id);
  }
}

class TestStaleRunReconciler extends StaleRunReconciler {
  readonly writer = new RecordingStatusWriter();
  clock = 5000;

  protected override now(): number {
    return this.clock;
  }

  protected override createStatusWriter(): CoalescedStatusWriterContract<ReconcilableStatus> {
    return this.writer;
  }
}

const trackedRunDirs: string[] = [];

function makeRunId(label: string): string {
  const runId = `${label}-${randomUUID()}`;
  trackedRunDirs.push(path.join(currentRunsDir(), runId));
  return runId;
}

function writeStatus(runId: string, status: object): void {
  fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
  fs.writeFileSync(path.join(currentRunsDir(), runId, 'status.json'), JSON.stringify(status));
}

afterEach(() => {
  while (trackedRunDirs.length > 0) {
    const dir = trackedRunDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StaleRunReconciler.reconcile - no status to act on', () => {
  it('does nothing for a run with no status.json at all, rather than synthesizing one', () => {
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('no-status');

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(false);
    expect(inspector.calls).toEqual([]);
    expect(reconciler.writer.opened).toBeUndefined();
  });

  it('does nothing for a status.json that fails to parse (a torn read mid-write)', () => {
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('torn-status');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
    fs.writeFileSync(path.join(currentRunsDir(), runId, 'status.json'), '{"state": "run');

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(false);
    expect(reconciler.writer.opened).toBeUndefined();
  });

  it('propagates an unexpected read failure rather than silently treating it as "no status"', () => {
    // Only ENOENT means "not written yet". Any other failure - here, reading
    // a directory as if it were the status file, which throws EISDIR - is a
    // real problem that must surface, not be swallowed alongside the normal
    // "run has not started" case.
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('status-is-a-directory');
    fs.mkdirSync(path.join(currentRunsDir(), runId, 'status.json'), { recursive: true });

    expect(() => reconciler.reconcile(runId)).toThrow();
  });
});

describe('StaleRunReconciler.reconcile - already terminal', () => {
  for (const state of ['complete', 'completed', 'failed', 'paused', 'stopped']) {
    it(`does nothing when status.json already reports a terminal state (${state})`, () => {
      const inspector = new FakeProcessTerminalInspector();
      const resolver = new FakeRunIdResolver();
      const reconciler = new TestStaleRunReconciler(inspector, resolver);
      const runId = makeRunId(`terminal-${state}`);
      writeStatus(runId, { state });

      const outcome = reconciler.reconcile(runId);

      expect(outcome.repaired).toBe(false);
      expect(inspector.calls).toEqual([]);
    });
  }
});

describe('StaleRunReconciler.reconcile - defers to ResultWatcher', () => {
  it('does nothing when a result already exists (pending), even if the process is provably dead', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const resolver = new FakeRunIdResolver();
    resolver.location = {
      runId: 'x',
      runDir: undefined,
      resultPath: '/tmp/somewhere/x.json',
      claimed: false,
    };
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('has-pending-result');
    writeStatus(runId, { state: 'running' });

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(false);
    expect(outcome.reason).toMatch(/ResultWatcher/);
    // The process-terminal question is never even asked once a result exists;
    // whether the process is alive or dead no longer matters to this module.
    expect(inspector.calls).toEqual([]);
    expect(reconciler.writer.opened).toBeUndefined();
  });

  it('does nothing when a result already exists (claimed)', () => {
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    resolver.location = { runId: 'x', runDir: '/tmp/x', resultPath: '/tmp/x/claimed-result.json', claimed: true };
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('has-claimed-result');
    writeStatus(runId, { state: 'running' });

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(false);
    expect(reconciler.writer.opened).toBeUndefined();
  });
});

describe('StaleRunReconciler.reconcile - liveness gating (never a guess)', () => {
  it("does not repair when liveness is 'alive'", () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'alive', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('alive');
    writeStatus(runId, { state: 'running' });

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(false);
    expect(reconciler.writer.opened).toBeUndefined();
  });

  it("does not repair when liveness is 'unknown', which is the whole point of not guessing", () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'unknown', marker: undefined };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('unknown-liveness');
    writeStatus(runId, { state: 'running' });

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(false);
    expect(reconciler.writer.opened).toBeUndefined();
  });
});

describe('StaleRunReconciler.reconcile - the one path that repairs', () => {
  it("repairs to 'failed' only when liveness is 'crashed' and no result exists", () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 9999, startedAt: 100 } };
    const resolver = new FakeRunIdResolver();
    resolver.location = undefined;
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('crashed');
    writeStatus(runId, { state: 'running', startedAt: 100 });

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(true);
    expect(reconciler.writer.opened?.runId).toBe(runId);
    expect(reconciler.writer.opened?.initialStatus).toEqual({ state: 'running', startedAt: 100 });
    expect(reconciler.writer.syncFlushes).toHaveLength(1);
    const flushed = reconciler.writer.syncFlushes[0];
    expect(flushed?.state).toBe('failed');
    expect(flushed?.error).toContain('9999');
    expect(flushed?.lastUpdate).toBe(5000);
    expect(flushed?.endedAt).toBe(5000);
  });

  it('preserves every other field of the on-disk status verbatim, since this package has no shared status type to reconstruct from', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('preserve-fields');
    writeStatus(runId, {
      state: 'running',
      mode: 'chain',
      steps: [{ agent: 'reviewer', status: 'running' }],
      capabilityCeiling: { allowedTools: ['read'] },
    });

    reconciler.reconcile(runId);

    const flushed = reconciler.writer.syncFlushes[0];
    expect(flushed?.mode).toBe('chain');
    expect(flushed?.steps).toEqual([{ agent: 'reviewer', status: 'running' }]);
    expect(flushed?.capabilityCeiling).toEqual({ allowedTools: ['read'] });
  });

  it('does not overwrite an error the status already carried', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('keep-existing-error');
    writeStatus(runId, { state: 'running', error: 'earlier tool failure' });

    reconciler.reconcile(runId);

    expect(reconciler.writer.syncFlushes[0]?.error).toBe('earlier tool failure');
  });

  it('does not overwrite an endedAt the status already carried', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('keep-existing-ended-at');
    writeStatus(runId, { state: 'running', endedAt: 42 });

    reconciler.reconcile(runId);

    expect(reconciler.writer.syncFlushes[0]?.endedAt).toBe(42);
  });

  it('appends a best-effort diagnostic event and never lets a broken event log fail the repair', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('events-log');
    writeStatus(runId, { state: 'running' });

    const outcome = reconciler.reconcile(runId);

    expect(outcome.repaired).toBe(true);
    const eventsPath = path.join(currentRunsDir(), runId, 'events.jsonl');
    const events = fs
      .readFileSync(eventsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; runId: string; pid: number });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'subagent.run.repaired_stale', runId, pid: 1 });
  });

  it('never asks about a result before it has confirmed the run is even in flight', () => {
    // A terminal status must short-circuit before either dependency is asked
    // anything, which the earlier "already terminal" tests assert on
    // `inspector.calls`; this test asserts the same for the resolver.
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);
    const runId = makeRunId('terminal-skips-resolver');
    writeStatus(runId, { state: 'complete' });

    reconciler.reconcile(runId);

    expect(resolver.calls).toEqual([]);
  });
});

describe('StaleRunReconciler.sweepOrphanedClaims - steer-requests queue', () => {
  function claimsDirFor(runId: string): string {
    return steerRequestsDir(path.join(currentRunsDir(), runId));
  }

  function writeClaimedSteerRequest(runId: string, originalName: string, claimant: string): string {
    const dir = claimsDirFor(runId);
    fs.mkdirSync(dir, { recursive: true });
    const claimedName = `${originalName}.claim-${claimant}`;
    fs.writeFileSync(path.join(dir, claimedName), JSON.stringify({ id: originalName, message: 'stop' }));
    return claimedName;
  }

  it('recovers an orphaned claim back to its original queued name when the claimant is provably dead', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 4242, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('orphaned-claim');
    writeClaimedSteerRequest(runId, '0000000000001-abc.json', '4242-dead-uuid');

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect(outcome.recovered).toEqual([{ queue: 'control/steer-requests', fileName: '0000000000001-abc.json' }]);
    // The steer is back under its original name, so the next scan picks it
    // up and redelivers it - recovering it is the whole point.
    const remaining = fs.readdirSync(claimsDirFor(runId));
    expect(remaining).toEqual(['0000000000001-abc.json']);
  });

  it("leaves a claim untouched when the run's process is still alive, never delivering it twice", () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'alive', marker: { version: 1, runId: 'x', pid: 4242, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('live-claim');
    const claimedName = writeClaimedSteerRequest(runId, '0000000000002-abc.json', '4242-live-uuid');

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect(outcome.recovered).toEqual([]);
    // Still claimed, under its claimed name: a live consumer may be mid
    // dispatch, and reclaiming it would risk delivering the same steer twice.
    expect(fs.readdirSync(claimsDirFor(runId))).toEqual([claimedName]);
  });

  it("leaves a claim untouched when liveness is 'unknown', the same standard reconcile() uses", () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'unknown', marker: undefined };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('unknown-liveness-claim');
    const claimedName = writeClaimedSteerRequest(runId, '0000000000003-abc.json', 'some-uuid');

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect(outcome.recovered).toEqual([]);
    expect(fs.readdirSync(claimsDirFor(runId))).toEqual([claimedName]);
  });

  it('recovers every orphaned claim in the directory, not just the first', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('multiple-orphaned-claims');
    writeClaimedSteerRequest(runId, '0000000000001-a.json', 'claimant-1');
    writeClaimedSteerRequest(runId, '0000000000002-b.json', 'claimant-2');

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect([...outcome.recovered].sort((left, right) => left.fileName.localeCompare(right.fileName))).toEqual([
      { queue: 'control/steer-requests', fileName: '0000000000001-a.json' },
      { queue: 'control/steer-requests', fileName: '0000000000002-b.json' },
    ]);
  });

  it('leaves an unclaimed, already-queued steer request alone', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('unclaimed-request');
    const dir = claimsDirFor(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0000000000001-a.json'), JSON.stringify({ id: 'a', message: 'stop' }));

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect(outcome.recovered).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(['0000000000001-a.json']);
  });

  it('does nothing, without throwing, when the run has no claim-queue directories at all', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('no-claim-dirs');

    expect(() => reconciler.sweepOrphanedClaims(runId)).not.toThrow();
    expect(reconciler.sweepOrphanedClaims(runId).recovered).toEqual([]);
  });

  it('propagates an unexpected directory-listing failure rather than silently treating it as "nothing to sweep"', () => {
    // Only ENOENT means "no run directory yet". Any other failure - here,
    // listing a plain file as if it were the run's own directory, which
    // throws ENOTDIR - is a real problem that must surface. The recursive
    // walk only ever readdirSync()s a path it already confirmed is a
    // directory via Dirent.isDirectory() before descending, so the only way
    // to reach this branch is the walk's own starting point.
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('run-dir-is-a-file');
    fs.writeFileSync(path.join(currentRunsDir(), runId), 'not a directory');

    expect(() => reconciler.sweepOrphanedClaims(runId)).toThrow();
  });

  it('does not descend into a subdirectory entry that happens to share a claim-queue name but is actually a plain file, without throwing', () => {
    // A file (not a directory) that collides with a queue directory's name is
    // simply skipped by the walk - it is neither a claim entry (no
    // `.claim-` in its name) nor something to recurse into
    // (`isDirectory()` is false) - rather than surfacing an error.
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('steer-dir-is-a-file');
    fs.mkdirSync(path.join(currentRunsDir(), runId, 'control'), { recursive: true });
    fs.writeFileSync(path.join(currentRunsDir(), runId, 'control', 'steer-requests'), 'not a directory');

    expect(() => reconciler.sweepOrphanedClaims(runId)).not.toThrow();
    expect(reconciler.sweepOrphanedClaims(runId).recovered).toEqual([]);
  });

  it('drops an orphaned claim it cannot recover instead of leaving it stuck forever', () => {
    // Mirrors control-channel.ts's own release() fallback: if the original
    // name cannot be reclaimed (occupied by something rename cannot replace,
    // here a pre-existing directory of the same name), there is nothing left
    // to preserve by retrying, so the claim is dropped rather than left an
    // unreachable, permanently orphaned file.
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('cannot-recover-claim');
    const claimedName = writeClaimedSteerRequest(runId, '0000000000001-a.json', 'claimant');
    fs.mkdirSync(path.join(claimsDirFor(runId), '0000000000001-a.json'));

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect(outcome.recovered).toEqual([]);
    expect(fs.existsSync(path.join(claimsDirFor(runId), claimedName))).toBe(false);
  });

  it('does not gate on the claimant string at all - a claimant with no embedded pid is still swept once the process is provably dead', () => {
    // port-steering confirmed the bare `randomUUID()` default claimant (no
    // pid) is real and reachable, and that no pid should ever be parsed out
    // of the claimant string. This pins that: an unparseable claimant must
    // not stop the sweep once the crash marker alone proves death.
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('pidless-claimant');
    writeClaimedSteerRequest(runId, '0000000000001-a.json', 'not-a-pid-at-all');

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect(outcome.recovered).toEqual([{ queue: 'control/steer-requests', fileName: '0000000000001-a.json' }]);
  });

  it('appends a best-effort diagnostic event for each recovered claim, tagged with its queue', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 4242, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('sweep-events');
    writeClaimedSteerRequest(runId, '0000000000001-a.json', 'claimant');

    reconciler.sweepOrphanedClaims(runId);

    const events = fs
      .readFileSync(path.join(currentRunsDir(), runId, 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; runId: string; queue: string; recovered: string });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'subagent.run.claim_recovered',
      runId,
      queue: 'control/steer-requests',
      recovered: '0000000000001-a.json',
    });
  });
});

describe('StaleRunReconciler.sweepOrphanedClaims - sweeps every queue in one call', () => {
  it('recovers orphaned claims from both steer-requests and append-requests in a single call', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('both-queues');

    const steerDir = steerRequestsDir(path.join(currentRunsDir(), runId));
    fs.mkdirSync(steerDir, { recursive: true });
    fs.writeFileSync(
      path.join(steerDir, '0000000000001-steer.json.claim-claimant'),
      JSON.stringify({ id: 'steer', message: 'stop' }),
    );

    // A second queue directory, named by convention rather than imported: the
    // sweep discovers claims structurally, so it needs no module to declare
    // this queue exists.
    const appendDir = path.join(currentRunsDir(), runId, 'append-requests');
    fs.mkdirSync(appendDir, { recursive: true });
    fs.writeFileSync(
      path.join(appendDir, `1700000000002-append.json.claim-${randomUUID()}`),
      JSON.stringify({ id: 'append', content: 'more work' }),
    );

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect([...outcome.recovered].sort((left, right) => left.queue.localeCompare(right.queue))).toEqual([
      { queue: 'append-requests', fileName: '1700000000002-append.json' },
      { queue: 'control/steer-requests', fileName: '0000000000001-steer.json' },
    ]);
  });

  it('sweeps a queue directory this module has never heard of, with zero code changes - the point of discovering claims structurally instead of via a registry', () => {
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId: 'x', pid: 1, startedAt: 0 } };
    const reconciler = new TestStaleRunReconciler(inspector, new FakeRunIdResolver());
    const runId = makeRunId('unregistered-future-queue');

    // Neither control-channel.ts nor chain-append.ts nor this module knows
    // this directory exists; it is shaped like a claim purely by naming
    // convention, the same convention both real queues already follow.
    const futureDir = path.join(currentRunsDir(), runId, 'future-requests');
    fs.mkdirSync(futureDir, { recursive: true });
    fs.writeFileSync(
      path.join(futureDir, '1700000000003-future.json.claim-some-claimant'),
      JSON.stringify({ id: 'future', payload: 'not built yet' }),
    );

    const outcome = reconciler.sweepOrphanedClaims(runId);

    expect(outcome.recovered).toEqual([{ queue: 'future-requests', fileName: '1700000000003-future.json' }]);
    expect(fs.readdirSync(futureDir)).toEqual(['1700000000003-future.json']);
  });
});

describe('reconcileAndSweep - one inspect per pass, not two', () => {
  it('probes the owning process exactly once when both repairs need the answer', () => {
    // The regression this pins: the parent poll subscriber used to call
    // `reconcile()` and `sweepOrphanedClaims()` separately, and each opened the
    // crash marker and ran `kill(pid, 0)`. Both gate on the same question, so
    // the second probe could only ever repeat the first answer.
    const runId = makeRunId('shared-inspect');
    writeStatus(runId, { runId, state: 'running' });
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);

    reconciler.reconcileAndSweep(runId);

    expect(inspector.calls).toEqual([runId]);
  });

  it('still probes once when the process is provably dead and both repairs actually run', () => {
    const runId = makeRunId('shared-inspect-crashed');
    writeStatus(runId, { runId, state: 'running' });
    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = { state: 'crashed', marker: { version: 1, runId, pid: 4242, startedAt: 0 } };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);

    const outcome = reconciler.reconcileAndSweep(runId);

    expect(inspector.calls).toEqual([runId]);
    expect(outcome.reconcile.repaired).toBe(true);
  });

  it('still probes only once for an already-terminal run, because the sweep gates independently', () => {
    // `reconcile` short-circuits on terminal status without asking about
    // liveness, but `sweepOrphanedClaims` deliberately does not consult
    // status.json at all - a finished run can still have left a claim behind.
    // So the guarantee is one probe, not zero. Folding the sweep into
    // reconcile's status gate would make it cheaper by quietly dropping
    // orphaned-claim recovery for terminal runs.
    const runId = makeRunId('terminal');
    writeStatus(runId, { runId, state: 'completed' });
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);

    const outcome = reconciler.reconcileAndSweep(runId);

    expect(outcome.reconcile.repaired).toBe(false);
    expect(outcome.reconcile.reason).toMatch(/already terminal/);
    expect(inspector.calls).toEqual([runId]);
  });

  it('returns the same verdicts the two methods return on their own', () => {
    const runId = makeRunId('parity');
    writeStatus(runId, { runId, state: 'running' });
    const inspector = new FakeProcessTerminalInspector();
    const resolver = new FakeRunIdResolver();
    const combined = new TestStaleRunReconciler(inspector, resolver).reconcileAndSweep(runId);
    const separate = new TestStaleRunReconciler(new FakeProcessTerminalInspector(), new FakeRunIdResolver());

    expect(combined.reconcile).toEqual(separate.reconcile(runId));
    expect(combined.sweep).toEqual(separate.sweepOrphanedClaims(runId));
  });

  it('uses asynchronous reads and claim recovery for the recurring reconciliation path', async () => {
    const runId = makeRunId('async-pass');
    writeStatus(runId, { runId, state: 'running' });
    const queueDir = path.join(currentRunsDir(), runId, 'nested', 'requests');
    fs.mkdirSync(queueDir, { recursive: true });
    const claimedPath = path.join(queueDir, 'request.json.claim-runner');
    fs.writeFileSync(claimedPath, '{}');

    const inspector = new FakeProcessTerminalInspector();
    inspector.verdict = {
      state: 'crashed',
      marker: { version: 1, runId, pid: 42, startedAt: 1 },
    };
    const resolver = new FakeRunIdResolver();
    const reconciler = new TestStaleRunReconciler(inspector, resolver);

    const outcome = await reconciler.reconcileAndSweepAsync(runId);

    expect(outcome.reconcile.repaired).toBe(true);
    expect(outcome.sweep.recovered).toEqual([{ queue: 'nested/requests', fileName: 'request.json' }]);
    expect(fs.existsSync(path.join(queueDir, 'request.json'))).toBe(true);
    expect(inspector.calls).toEqual([runId]);
    expect(resolver.calls).toEqual([runId]);
  });
});
