import { beforeEach, describe, expect, it } from 'vitest';

import { RunnerBootstrap, type RunnerLaunchConfig } from '../../src/adapters/runs/background/runnerBootstrap';
import { currentRunConfigPath, currentRunsDir } from '../../src/adapters/filesystem/paths';
import * as path from 'node:path';
import { handshakePathFor, type AsyncRunStatus } from '../../src/adapters/runs/background/asyncExecution';
import { SUBAGENT_RUN_ID_ENV } from '../../src/exports/env';
import type { CoalescedStatusWriterContract } from '../../src/adapters/runs/background/statusWriter';
import type { TerminalPersistenceContract } from '../../src/adapters/runs/background/terminalPersistence';
import type { RunnerReportingContract } from '../../src/adapters/runs/background/runnerReporting';
import type {
  RunnerTeamMembershipContract,
  RunnerTeamRegistration,
} from '../../src/adapters/runs/background/runnerTeamMembership';
import type { RegisterNativeTeamMemberInput, TeamRootContext } from '../../src/adapters/intercom/nativeTeamChannel';

class FakeStatusWriter implements CoalescedStatusWriterContract<AsyncRunStatus> {
  opened: Array<{ runId: string; status: AsyncRunStatus }> = [];
  open(runId: string, initialStatus: AsyncRunStatus): void {
    this.opened.push({ runId, status: initialStatus });
  }
  update(): void {}
  updateSync(): void {}
  appendTool(): void {}
  appendOutput(): void {}
  close(): void {}
}

class FakeTerminalPersistence implements TerminalPersistenceContract<AsyncRunStatus> {
  begun: Array<{ runId: string; mutate: (status: AsyncRunStatus, trigger: undefined) => void }> = [];
  begin(runId: string, mutateTerminalStatus: (status: AsyncRunStatus, trigger: undefined) => void): void {
    this.begun.push({ runId, mutate: mutateTerminalStatus });
  }
  trackChild(): void {}
  untrackChild(): void {}
  finalize(): void {}
  dispose(): void {}
}

class FakeReporting implements RunnerReportingContract {
  prepared: unknown;
  mutateCalls: Array<{ status: AsyncRunStatus; trigger: unknown }> = [];
  prepareResult(input: unknown): void {
    this.prepared = input;
  }
  mutateTerminalStatus(status: AsyncRunStatus, trigger: unknown): void {
    this.mutateCalls.push({ status, trigger });
  }
  recordSessionFile(sessionFile: string): string {
    return sessionFile;
  }
}

const fakeTeamRoot: TeamRootContext = {
  version: 1,
  teamId: 'team-1',
  rootSessionId: 'root-session-1',
  mainMemberId: 'main',
};

class FakeTeamMembership implements RunnerTeamMembershipContract {
  root: TeamRootContext | undefined = fakeTeamRoot;
  registerCalls: RegisterNativeTeamMemberInput[] = [];
  /**
   * Typed `Error` rather than `unknown` so the double can only simulate what
   * the real registration path can actually throw. A test double that can
   * throw a bare string proves the caller handles a case production never
   * produces, while telling you nothing about the one it does.
   */
  registerError: Error | undefined;
  disposeCalls = 0;

  readRoot(): TeamRootContext | undefined {
    return this.root;
  }

  register(input: RegisterNativeTeamMemberInput): RunnerTeamRegistration {
    this.registerCalls.push(input);
    if (this.registerError) throw this.registerError;
    return {
      context: { ...input.root, memberId: input.agent ?? 'member', token: 'tok', role: input.role },
      dispose: () => {
        this.disposeCalls += 1;
      },
    };
  }
}

/** Redirects `readFile`/`writeHandshake` to an in-memory map instead of real disk. */
class TestableRunnerBootstrap extends RunnerBootstrap {
  files = new Map<string, string>();
  handshakeWrites: Array<{ path: string; payload: { state: 'ready' } | { state: 'error'; error: string } }> = [];
  envRunId: string | undefined;

  protected override resolveRunIdFromEnv(): string | undefined {
    return this.envRunId;
  }

  protected override readFile(filePath: string): string | undefined {
    return this.files.get(filePath);
  }

  protected override writeHandshake(
    filePath: string,
    payload: { state: 'ready' } | { state: 'error'; error: string },
  ): void {
    this.handshakeWrites.push({ path: filePath, payload });
  }

  protected override now(): number {
    return 42;
  }
}

function validLaunchConfig(runId: string, overrides: Partial<RunnerLaunchConfig> = {}): RunnerLaunchConfig {
  return {
    runId,
    agent: 'planner',
    task: 'do the thing',
    cwd: '/work',
    childIndex: 0,
    handshakePath: handshakePathFor(runId),
    sdk: {
      extensions: [],
      noAmbientExtensions: false,
      skillPaths: [],
      noSkills: true,
      noContextFiles: true,
      sessionEnabled: false,
    },
    args: [],
    env: {},
    ...overrides,
  };
}

describe('RunnerBootstrap', () => {
  let statusWriter: FakeStatusWriter;
  let terminalPersistence: FakeTerminalPersistence;
  let reporting: FakeReporting;
  let teamMembership: FakeTeamMembership;
  let bootstrap: TestableRunnerBootstrap;

  beforeEach(() => {
    statusWriter = new FakeStatusWriter();
    terminalPersistence = new FakeTerminalPersistence();
    reporting = new FakeReporting();
    teamMembership = new FakeTeamMembership();
    bootstrap = new TestableRunnerBootstrap(statusWriter, terminalPersistence, reporting, teamMembership);
  });

  it('throws, with no handshake write, when no run id is available at all', () => {
    bootstrap.envRunId = undefined;

    expect(() => bootstrap.bootstrap()).toThrow(SUBAGENT_RUN_ID_ENV);
    expect(bootstrap.handshakeWrites).toHaveLength(0);
  });

  it('resolves the run id from the environment when none is passed explicitly', () => {
    bootstrap.envRunId = 'run-from-env';
    bootstrap.files.set(currentRunConfigPath('run-from-env'), JSON.stringify(validLaunchConfig('run-from-env')));

    const result = bootstrap.bootstrap();

    expect(result.runId).toBe('run-from-env');
  });

  it('an explicit runId argument takes precedence over the environment', () => {
    bootstrap.envRunId = 'run-from-env';
    bootstrap.files.set(currentRunConfigPath('run-explicit'), JSON.stringify(validLaunchConfig('run-explicit')));

    const result = bootstrap.bootstrap('run-explicit');

    expect(result.runId).toBe('run-explicit');
  });

  it('writes an error handshake and throws when no launch config file exists for the run', () => {
    expect(() => bootstrap.bootstrap('missing-run')).toThrow(/No launch config found/);

    expect(bootstrap.handshakeWrites).toEqual([
      {
        path: handshakePathFor('missing-run'),
        payload: { state: 'error', error: expect.stringContaining('No launch config found') },
      },
    ]);
  });

  it('writes an error handshake and throws when the launch config is not valid JSON', () => {
    bootstrap.files.set(currentRunConfigPath('bad-json'), '{not json');

    expect(() => bootstrap.bootstrap('bad-json')).toThrow(/not valid JSON/);
    expect(bootstrap.handshakeWrites[0]?.payload).toMatchObject({ state: 'error' });
  });

  it("writes an error handshake and throws when the launch config's runId does not match", () => {
    bootstrap.files.set(currentRunConfigPath('run-a'), JSON.stringify(validLaunchConfig('run-b')));

    expect(() => bootstrap.bootstrap('run-a')).toThrow(/mismatched 'runId'/);
    expect(bootstrap.handshakeWrites[0]).toMatchObject({ path: handshakePathFor('run-a') });
  });

  it('on success: opens status, wires finalize into terminal persistence, and writes a ready handshake', () => {
    const runId = 'run-ok';
    bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));

    const result = bootstrap.bootstrap(runId);

    expect(statusWriter.opened).toEqual([
      {
        runId,
        status: expect.objectContaining({
          runId,
          agent: 'planner',
          state: 'running',
          startedAt: 42,
          lastUpdate: 42,
        }),
      },
    ]);
    expect(terminalPersistence.begun).toHaveLength(1);
    expect(terminalPersistence.begun[0]?.runId).toBe(runId);
    expect(bootstrap.handshakeWrites).toEqual([{ path: handshakePathFor(runId), payload: { state: 'ready' } }]);
    expect(result.runId).toBe(runId);
    // Returned, not just persisted onto status.json, so a caller (the
    // deliverable-guard trigger) reads it back rather than re-deriving it.
  });

  it('writes the validated session file into running status before signalling ready', () => {
    const runId = 'run-restorable';
    bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));

    bootstrap.bootstrap(runId, '/sessions/run-restorable.jsonl');

    expect(statusWriter.opened[0]?.status.sessionFile).toBe('/sessions/run-restorable.jsonl');
    expect(bootstrap.handshakeWrites).toEqual([{ path: handshakePathFor(runId), payload: { state: 'ready' } }]);
  });

  it('the finalize callback wired into terminal persistence forwards straight through to RunnerReporting', () => {
    const runId = 'run-forward';
    bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));

    bootstrap.bootstrap(runId);
    const mutate = terminalPersistence.begun[0]!.mutate;
    const status = { runId, agent: 'planner' } as AsyncRunStatus;
    mutate(status, undefined);

    expect(reporting.mutateCalls).toEqual([{ status, trigger: undefined }]);
  });

  it("preserves an existing status.json's fanoutIndex and startedAt instead of resetting them", () => {
    const runId = 'run-existing-status';
    bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));
    bootstrap.files.set(
      path.join(currentRunsDir(), runId, 'status.json'),
      JSON.stringify({
        runId,
        agent: 'planner',
        state: 'running',
        startedAt: 7,
        lastUpdate: 7,
        fanoutIndex: 2,
      }),
    );

    bootstrap.bootstrap(runId);

    expect(statusWriter.opened[0]?.status).toMatchObject({ startedAt: 7, fanoutIndex: 2 });
  });

  it("writes an error handshake at the launch config's own handshakePath, and rethrows, when opening status fails", () => {
    const runId = 'run-open-throws';
    bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));
    statusWriter.open = () => {
      throw new Error('disk unavailable');
    };

    expect(() => bootstrap.bootstrap(runId)).toThrow('disk unavailable');
    expect(bootstrap.handshakeWrites).toEqual([
      { path: handshakePathFor(runId), payload: { state: 'error', error: 'disk unavailable' } },
    ]);
  });

  describe('team membership (additive - see the module header)', () => {
    it('registers as a subagent team member when the parent forwarded a team root', () => {
      const runId = 'run-team';
      bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));

      bootstrap.bootstrap(runId);

      expect(teamMembership.registerCalls).toEqual([
        {
          root: fakeTeamRoot,
          role: 'subagent',
          agent: 'planner',
          runId,
          childIndex: 0,
          fanoutIndex: undefined,
          task: { id: runId, subject: 'do the thing' },
          pid: process.pid,
        },
      ]);
    });

    it("derives fanoutIndex from a fan-out run's recorded status", () => {
      const runId = 'run-team-fanout';
      bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId, { childIndex: 2 })));
      bootstrap.files.set(
        path.join(currentRunsDir(), runId, 'status.json'),
        JSON.stringify({
          runId,
          agent: 'planner',
          state: 'running',
          startedAt: 7,
          lastUpdate: 7,
          fanoutIndex: 2,
        }),
      );

      bootstrap.bootstrap(runId);

      expect(teamMembership.registerCalls[0]?.fanoutIndex).toBe(2);
    });

    it('does not attempt registration when this process has no team root (not part of a team)', () => {
      const runId = 'run-no-team';
      bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));
      teamMembership.root = undefined;

      const result = bootstrap.bootstrap(runId);

      expect(teamMembership.registerCalls).toHaveLength(0);
      expect(result.runId).toBe(runId); // the run still bootstraps successfully
    });

    it('records a registration failure instead of throwing, and the run still bootstraps successfully', () => {
      const runId = 'run-team-fails';
      bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));
      teamMembership.registerError = new Error('team channel unavailable');

      const result = bootstrap.bootstrap(runId);

      expect(result.runId).toBe(runId);
      expect(bootstrap.lastTeamRegistrationError?.runId).toBe(runId);
      expect(bootstrap.lastTeamRegistrationError?.error).toEqual(new Error('team channel unavailable'));
      // Still reaches the ready handshake - a team registration failure is not fatal.
      expect(bootstrap.handshakeWrites).toEqual([{ path: handshakePathFor(runId), payload: { state: 'ready' } }]);
    });

    it('disposes the team registration from inside the SAME finalize callback RunnerReporting uses, not a second cleanup site', () => {
      const runId = 'run-team-dispose';
      bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));

      bootstrap.bootstrap(runId);
      expect(teamMembership.disposeCalls).toBe(0);

      const mutate = terminalPersistence.begun[0]!.mutate;
      const status = { runId, agent: 'planner' } as AsyncRunStatus;
      mutate(status, undefined);

      expect(reporting.mutateCalls).toHaveLength(1); // RunnerReporting still ran
      expect(teamMembership.disposeCalls).toBe(1); // and dispose rode the same callback
    });

    it('does not call dispose when there was nothing to register in the first place', () => {
      const runId = 'run-team-no-dispose';
      bootstrap.files.set(currentRunConfigPath(runId), JSON.stringify(validLaunchConfig(runId)));
      teamMembership.root = undefined;

      bootstrap.bootstrap(runId);
      const mutate = terminalPersistence.begun[0]!.mutate;
      mutate({ runId, agent: 'planner' } as AsyncRunStatus, undefined);

      expect(teamMembership.disposeCalls).toBe(0);
    });
  });
});
