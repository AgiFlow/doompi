import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startParentWatchdog } from '../../src/adapters/runs/background/parentWatchdog';
import { type ProcessGroupSignals, stopProcessGroup } from '../../src/adapters/runs/registry/processGroup';
import {
  findReapableScopes,
  findReapableScopesAsync,
  listRuns,
  listRunsAsync,
  pruneDeadRuns,
  pruneDeadRunsAsync,
  registerRun,
  releaseRun,
} from '../../src/adapters/runRegistry';
import { openScope, openScopeAsync, suspendScopeRuns } from '../../src/adapters/runs/registry/sessionLifecycle';
import {
  formatSuspendedRuns,
  formatSuspendedRunsAsync,
  isSuspendedRunResumableAsync,
  listSuspendedRuns,
  listSuspendedRunsAsync,
  type SuspendedRun,
  suspendRun,
  suspendRunAsync,
} from '../../src/adapters/suspendedRuns';
import {
  createSessionScope,
  type SessionScope,
  scopeSuspendedDir,
  sessionScopeDir,
} from '../../src/adapters/filesystem/paths';
import { writeScopeOwner } from '../../src/adapters/scopeOwner';

const scopes: SessionScope[] = [];

function makeScope(label: string): SessionScope {
  const scope = createSessionScope(`lifecycle-${label}-${Math.random().toString(36).slice(2, 10)}`);
  scopes.push(scope);
  return scope;
}

/** Every pid in `alive` is running; nothing else is. */
function liveness(alive: number[]): (pid: number) => boolean {
  const set = new Set(alive);
  return (pid) => set.has(pid);
}

afterEach(() => {
  while (scopes.length > 0) {
    const scope = scopes.pop();
    if (scope) fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
  }
});

describe('run registry', () => {
  it('records a run against its scope and reads it back', () => {
    const scope = makeScope('record');
    registerRun(scope, { runId: 'run-1', pid: 4242, agent: 'worker', runtime: 'pi', startedAt: 1 });

    expect(listRuns(scope)).toEqual([
      { runId: 'run-1', pid: 4242, agent: 'worker', runtime: 'pi', startedAt: 1, hostPid: process.pid },
    ]);
  });

  it('replaces rather than duplicates when the same run id is registered twice', () => {
    const scope = makeScope('replace');
    registerRun(scope, { runId: 'run-1', pid: 1, agent: 'a', runtime: 'pi', startedAt: 1 });
    registerRun(scope, { runId: 'run-1', pid: 2, agent: 'a', runtime: 'pi', startedAt: 2 });

    expect(listRuns(scope)).toHaveLength(1);
    expect(listRuns(scope)[0]?.pid).toBe(2);
  });

  it('keeps one scope out of another scope registry', () => {
    const first = makeScope('a');
    const second = makeScope('b');
    registerRun(first, { runId: 'run-a', pid: 1, agent: 'a', runtime: 'pi', startedAt: 0 });

    expect(listRuns(second)).toEqual([]);
  });

  it('releases a single run without touching its siblings', () => {
    const scope = makeScope('release');
    registerRun(scope, { runId: 'run-1', pid: 1, agent: 'a', runtime: 'pi', startedAt: 0 });
    registerRun(scope, { runId: 'run-2', pid: 2, agent: 'b', runtime: 'pi', startedAt: 0 });

    releaseRun(scope, 'run-1');

    expect(listRuns(scope).map((run) => run.runId)).toEqual(['run-2']);
  });

  it('prunes only the records whose process is gone', () => {
    const scope = makeScope('prune');
    registerRun(scope, { runId: 'dead', pid: 900, agent: 'a', runtime: 'pi', startedAt: 0 });
    registerRun(scope, { runId: 'alive', pid: 901, agent: 'b', runtime: 'pi', startedAt: 0 });

    expect(pruneDeadRuns(scope, liveness([901]))).toEqual(['dead']);
    expect(listRuns(scope).map((run) => run.runId)).toEqual(['alive']);
  });

  it('reports an unreadable registry as empty rather than throwing mid-sweep', () => {
    const scope = makeScope('torn');
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    fs.writeFileSync(`${sessionScopeDir(scope)}/registry.json`, '{"version": 1, "ru');

    expect(listRuns(scope)).toEqual([]);
  });

  it('provides promise-based registry reads and pruning for startup scans', async () => {
    const scope = makeScope('async-registry');
    registerRun(scope, { runId: 'dead', pid: 900, agent: 'a', runtime: 'pi', startedAt: 0 });
    registerRun(scope, { runId: 'alive', pid: 901, agent: 'b', runtime: 'pi', startedAt: 0 });

    await expect(pruneDeadRunsAsync(scope, liveness([901]))).resolves.toEqual(['dead']);
    await expect(listRunsAsync(scope)).resolves.toEqual([expect.objectContaining({ runId: 'alive', pid: 901 })]);
  });

  it('handles missing, malformed, and all-live registries asynchronously without rewriting them', async () => {
    const empty = makeScope('async-empty');
    releaseRun(empty, 'absent');
    expect(pruneDeadRuns(empty, liveness([]))).toEqual([]);
    await expect(listRunsAsync(empty)).resolves.toEqual([]);
    await expect(pruneDeadRunsAsync(empty, liveness([]))).resolves.toEqual([]);

    const malformed = makeScope('async-malformed');
    fs.mkdirSync(sessionScopeDir(malformed), { recursive: true });
    fs.writeFileSync(`${sessionScopeDir(malformed)}/registry.json`, '{bad json');
    await expect(listRunsAsync(malformed)).resolves.toEqual([]);

    const live = makeScope('async-live');
    registerRun(live, { runId: 'alive', pid: 901, agent: 'a', runtime: 'pi', startedAt: 0 });
    expect(pruneDeadRuns(live, liveness([901]))).toEqual([]);
    await expect(pruneDeadRunsAsync(live, liveness([901]))).resolves.toEqual([]);
    await expect(listRunsAsync(live)).resolves.toHaveLength(1);
  });
});

describe('findReapableScopes', () => {
  it('never returns the scope being kept, even when it holds nothing alive', () => {
    const keep = makeScope('keep');
    writeScopeOwner(keep);

    expect(findReapableScopes(keep, liveness([]))).toEqual([]);
  });

  it('reaps a sibling whose runs are all gone, even though its hostPid is this live process', () => {
    // The case a hostPid-only rule gets wrong: after /new the abandoned scope
    // is still owned by the running process.
    const keep = makeScope('keep');
    const abandoned = makeScope('abandoned');
    writeScopeOwner(keep);
    writeScopeOwner(abandoned);
    registerRun(abandoned, { runId: 'r', pid: 900, agent: 'a', runtime: 'pi', startedAt: 0 });

    const reapable = findReapableScopes(keep, liveness([]));

    expect(reapable.map((scope) => scope.scopeKey)).toContain(abandoned.scopeKey);
  });

  it('leaves a sibling alone while any of its runs is alive', () => {
    const keep = makeScope('keep');
    const busy = makeScope('busy');
    writeScopeOwner(keep);
    writeScopeOwner(busy);
    registerRun(busy, { runId: 'r', pid: 901, agent: 'a', runtime: 'pi', startedAt: 0 });

    expect(findReapableScopes(keep, liveness([901])).map((s) => s.scopeKey)).not.toContain(busy.scopeKey);
  });

  it('skips a scope with no readable owner: unknown is not the same as dead', () => {
    const keep = makeScope('keep');
    const unowned = makeScope('unowned');
    writeScopeOwner(keep);
    fs.mkdirSync(sessionScopeDir(unowned), { recursive: true });

    expect(findReapableScopes(keep, liveness([])).map((s) => s.scopeKey)).not.toContain(unowned.scopeKey);
  });

  it('discovers reapable sibling scopes asynchronously', async () => {
    const keep = makeScope('async-keep');
    const abandoned = makeScope('async-abandoned');
    writeScopeOwner(keep);
    writeScopeOwner(abandoned);

    const reapable = await findReapableScopesAsync(keep, liveness([]));

    expect(reapable.map((scope) => scope.scopeKey)).toContain(abandoned.scopeKey);
  });

  it('asynchronously skips the kept, unowned, and still-busy scopes', async () => {
    const keep = makeScope('async-skip-keep');
    const unowned = makeScope('async-skip-unowned');
    const busy = makeScope('async-skip-busy');
    writeScopeOwner(keep);
    fs.mkdirSync(sessionScopeDir(unowned), { recursive: true });
    writeScopeOwner(busy);
    registerRun(busy, { runId: 'alive', pid: 901, agent: 'a', runtime: 'pi', startedAt: 0 });

    const reapable = await findReapableScopesAsync(keep, liveness([901]));
    const keys = reapable.map((scope) => scope.scopeKey);

    expect(keys).not.toContain(keep.scopeKey);
    expect(keys).not.toContain(unowned.scopeKey);
    expect(keys).not.toContain(busy.scopeKey);
  });
});

describe('stopProcessGroup', () => {
  function recordingSignals(aliveFor: number): { signals: ProcessGroupSignals; sent: string[] } {
    let checks = 0;
    const sent: string[] = [];
    return {
      sent,
      signals: {
        signalGroup(pid, signal) {
          sent.push(`${signal}:${pid}`);
          return true;
        },
        isAlive() {
          checks += 1;
          return checks <= aliveFor;
        },
        wait: () => Promise.resolve(),
      },
    };
  }

  it('does nothing when the group is already gone', async () => {
    const { signals, sent } = recordingSignals(0);
    await expect(stopProcessGroup(10, 0, signals)).resolves.toBe(true);
    expect(sent).toEqual([]);
  });

  it('signals the GROUP, not the pid, so the agent subprocesses go too', async () => {
    const { signals, sent } = recordingSignals(1);
    await stopProcessGroup(10, 0, signals);
    expect(sent[0]).toBe('SIGTERM:10');
  });

  it('escalates to SIGKILL when the group outlasts the grace period', async () => {
    const { signals, sent } = recordingSignals(2);
    await stopProcessGroup(10, 0, signals);
    expect(sent).toEqual(['SIGTERM:10', 'SIGKILL:10']);
  });

  it('reports failure rather than asserting when even SIGKILL leaves it alive', async () => {
    const signals: ProcessGroupSignals = {
      signalGroup: () => true,
      isAlive: () => true,
      wait: () => Promise.resolve(),
    };
    await expect(stopProcessGroup(10, 0, signals)).resolves.toBe(false);
  });
});

describe('suspendScopeRuns', () => {
  const noopSignals: ProcessGroupSignals = {
    signalGroup: () => true,
    isAlive: () => false,
    wait: () => Promise.resolve(),
  };

  it('records how to restart each run, then clears it from the registry', async () => {
    const scope = makeScope('suspend');
    registerRun(scope, { runId: 'run-1', pid: 900, agent: 'worker', runtime: 'pi', startedAt: 0 });

    const result = await suspendScopeRuns({
      scope,
      reason: 'quit',
      readStatus: () => ({ sessionFile: '/tmp/child.jsonl', state: 'running' }) as never,
      now: () => 5,
      signals: noopSignals,
    });

    expect(result.suspended).toEqual(['run-1']);
    expect(listRuns(scope)).toEqual([]);
    const suspended = listSuspendedRuns(scope);
    expect(suspended).toHaveLength(1);
    // Without the child's own transcript a restore restarts the task instead
    // of continuing it, which is the whole point of recording it.
    expect(suspended[0]?.sessionFile).toBe('/tmp/child.jsonl');
    expect(suspended[0]?.reason).toBe('quit');
  });

  it('suspends on every reason, including reload, so there is no remembered exception', async () => {
    for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
      const scope = makeScope(`reason-${reason}`);
      registerRun(scope, { runId: 'r', pid: 900, agent: 'a', runtime: 'pi', startedAt: 0 });

      await suspendScopeRuns({ scope, reason, readStatus: () => undefined, signals: noopSignals });

      expect(listSuspendedRuns(scope), `reason '${reason}' did not suspend`).toHaveLength(1);
    }
  });

  it('records and signals every run before waiting for any process to exit', async () => {
    const scope = makeScope('two-phase');
    registerRun(scope, { runId: 'run-1', pid: 901, agent: 'a', runtime: 'pi', startedAt: 0 });
    registerRun(scope, { runId: 'run-2', pid: 902, agent: 'b', runtime: 'pi', startedAt: 0 });
    const sent: string[] = [];
    const resolveWaits: Array<() => void> = [];
    let alive = true;
    const signals: ProcessGroupSignals = {
      signalGroup(pid, signal) {
        sent.push(`${signal}:${pid}`);
        return true;
      },
      isAlive: () => alive,
      wait: () =>
        new Promise<void>((resolve) => {
          resolveWaits.push(resolve);
        }),
    };

    const suspension = suspendScopeRuns({ scope, reason: 'resume', readStatus: () => undefined, signals });

    expect(listSuspendedRuns(scope).map((run) => run.runId)).toEqual(['run-1', 'run-2']);
    expect(sent).toEqual(['SIGTERM:901', 'SIGTERM:902']);

    alive = false;
    for (const resolve of resolveWaits) resolve();
    await suspension;
  });
});

describe('openScope', () => {
  it('promotes dead owned runs to suspended records before pruning them', () => {
    const scope = makeScope('open');
    writeScopeOwner(scope);
    registerRun(scope, { runId: 'gone', pid: 900, agent: 'a', runtime: 'pi', startedAt: 0 });

    const opened = openScope(scope, {
      isAlive: liveness([]),
      readStatus: () =>
        ({
          task: 'continue inspection',
          cwd: '/work',
          sessionFile: '/missing/session.jsonl',
          state: 'running',
        }) as never,
      now: () => 10,
    });

    expect(opened.pruned).toEqual(['gone']);
    expect(opened.suspended).toEqual([
      expect.objectContaining({ runId: 'gone', task: 'continue inspection', reason: 'parent_lost', suspendedAt: 10 }),
    ]);
    // Nothing was started: the registry is empty because the record was
    // pruned, not because a run was re-launched.
    expect(listRuns(scope)).toEqual([]);
  });

  it('promotes and prunes dead runs through the asynchronous startup path', async () => {
    const scope = makeScope('open-async');
    writeScopeOwner(scope);
    registerRun(scope, { runId: 'gone', pid: 900, agent: 'a', runtime: 'pi', startedAt: 0 });

    const opened = await openScopeAsync(scope, {
      isAlive: liveness([]),
      readStatusAsync: async () =>
        ({
          task: 'continue asynchronously',
          cwd: '/work',
          sessionFile: '/missing/session.jsonl',
          state: 'running',
        }) as never,
      now: () => 11,
    });

    expect(opened.pruned).toEqual(['gone']);
    await expect(listSuspendedRunsAsync(scope)).resolves.toEqual([
      expect.objectContaining({ runId: 'gone', task: 'continue asynchronously', suspendedAt: 11 }),
    ]);
    await expect(listRunsAsync(scope)).resolves.toEqual([]);
  });

  it('does not overwrite a suspension record already written by graceful shutdown', () => {
    const scope = makeScope('open-existing');
    writeScopeOwner(scope);
    registerRun(scope, { runId: 'gone', pid: 900, agent: 'a', runtime: 'pi', startedAt: 0 });
    suspendRun(scope, {
      runId: 'gone',
      agent: 'a',
      runtime: 'pi',
      task: 'inspect',
      cwd: '/work',
      suspendedAt: 5,
      reason: 'resume',
    });

    const opened = openScope(scope, { isAlive: liveness([]), now: () => 99 });

    expect(opened.suspended[0]).toMatchObject({ runId: 'gone', reason: 'resume', suspendedAt: 5 });
  });
});

describe('asynchronous suspended-run persistence', () => {
  function resumableRun(sessionFile: string, overrides: Partial<SuspendedRun> = {}): SuspendedRun {
    return {
      version: 1,
      runId: 'run-1',
      agent: 'worker',
      runtime: 'pi',
      task: 'continue work',
      cwd: '/work',
      sessionFile,
      suspendedAt: 1,
      reason: 'quit',
      ...overrides,
    };
  }

  it('lists an absent suspended directory as empty', async () => {
    await expect(listSuspendedRunsAsync(makeScope('suspended-absent'))).resolves.toEqual([]);
  });

  it('writes, sorts, and skips unrelated or unreadable records asynchronously', async () => {
    const scope = makeScope('suspended-async');
    await suspendRunAsync(scope, {
      runId: 'later',
      agent: 'worker',
      runtime: 'pi',
      task: 'later work',
      cwd: '/work',
      suspendedAt: 2,
      reason: 'quit',
    });
    await suspendRunAsync(scope, {
      runId: 'earlier',
      agent: 'worker',
      runtime: 'pi',
      task: 'earlier work',
      cwd: '/work',
      suspendedAt: 1,
      reason: 'quit',
    });
    fs.writeFileSync(`${scopeSuspendedDir(scope)}/notes.txt`, 'ignore me');
    fs.writeFileSync(`${scopeSuspendedDir(scope)}/malformed.json`, '{bad json');
    fs.writeFileSync(`${scopeSuspendedDir(scope)}/future.json`, JSON.stringify({ version: 99, runId: 'future' }));
    fs.mkdirSync(`${scopeSuspendedDir(scope)}/unreadable.json`);

    expect(listSuspendedRuns(scope)).toMatchObject([
      { runId: 'earlier', suspendedAt: 1 },
      { runId: 'later', suspendedAt: 2 },
    ]);
    await expect(listSuspendedRunsAsync(scope)).resolves.toMatchObject([
      { runId: 'earlier', suspendedAt: 1 },
      { runId: 'later', suspendedAt: 2 },
    ]);
  });

  it('checks every resumability prerequisite and transcript readability asynchronously', async () => {
    const scope = makeScope('resumable-async');
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    const sessionFile = `${sessionScopeDir(scope)}/child.jsonl`;
    fs.writeFileSync(sessionFile, '');

    await expect(isSuspendedRunResumableAsync(resumableRun(sessionFile))).resolves.toBe(true);
    await expect(isSuspendedRunResumableAsync(resumableRun(sessionFile, { runtime: 'claude' }))).resolves.toBe(false);
    await expect(isSuspendedRunResumableAsync(resumableRun(sessionFile, { agent: ' ' }))).resolves.toBe(false);
    await expect(isSuspendedRunResumableAsync(resumableRun(sessionFile, { task: ' ' }))).resolves.toBe(false);
    await expect(isSuspendedRunResumableAsync(resumableRun(sessionFile, { cwd: ' ' }))).resolves.toBe(false);
    await expect(isSuspendedRunResumableAsync(resumableRun(sessionFile, { sessionFile: undefined }))).resolves.toBe(
      false,
    );
    await expect(isSuspendedRunResumableAsync(resumableRun(`${sessionFile}.missing`))).resolves.toBe(false);
  });
});

describe('formatSuspendedRuns', () => {
  it('is empty when there is nothing to report, so a clean start stays quiet', async () => {
    expect(formatSuspendedRuns([])).toBe('');
    await expect(formatSuspendedRunsAsync([])).resolves.toBe('');
  });

  it('says which runs can continue and which are not resumable', async () => {
    const scope = makeScope('format');
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    const sessionFile = `${sessionScopeDir(scope)}/child.jsonl`;
    fs.writeFileSync(sessionFile, '');
    const text = formatSuspendedRuns([
      {
        version: 1,
        runId: 'r1',
        agent: 'scout',
        runtime: 'pi',
        task: 'find the thing\nsecond line',
        cwd: '/w',
        sessionFile,
        suspendedAt: 1,
        reason: 'quit',
      },
      { version: 1, runId: 'r2', agent: 'w', runtime: 'claude', task: 'x', cwd: '/w', suspendedAt: 2, reason: 'quit' },
    ]);

    expect(text).toContain('2 suspended subagents');
    expect(text).toContain('r1 (scout, pi, resumable)');
    expect(text).toContain('r2 (w, claude, not resumable)');
    // Only the first line of a multi-line task, so a long prompt cannot flood
    // the notice.
    expect(text).not.toContain('second line');
    expect(
      formatSuspendedRuns([
        {
          version: 1,
          runId: 'single',
          agent: 'worker',
          runtime: 'claude',
          task: 'single task',
          cwd: '/w',
          suspendedAt: 1,
          reason: 'quit',
        },
      ]),
    ).toContain('1 suspended subagent');
    await expect(
      formatSuspendedRunsAsync([
        {
          version: 1,
          runId: 'r1',
          agent: 'scout',
          runtime: 'pi',
          task: 'find the thing\nsecond line',
          cwd: '/w',
          sessionFile,
          suspendedAt: 1,
          reason: 'quit',
        },
        {
          version: 1,
          runId: 'r2',
          agent: 'worker',
          runtime: 'claude',
          task: 'other work',
          cwd: '/w',
          suspendedAt: 2,
          reason: 'quit',
        },
      ]),
    ).resolves.toContain('2 suspended subagents');
  });
});

describe('startParentWatchdog', () => {
  it('fires immediately when already reparented to init, rather than waiting a tick', () => {
    let lost = 0;
    startParentWatchdog({ parentPid: 1, onParentLost: () => (lost += 1) });
    expect(lost).toBe(1);
  });

  it('does not fire while the parent is alive', () => {
    let lost = 0;
    const stop = startParentWatchdog({
      parentPid: 900,
      intervalMs: 1,
      isAlive: () => true,
      onParentLost: () => (lost += 1),
    });
    stop();
    expect(lost).toBe(0);
  });
});
