import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HARNESS_STATE_POINTER, updateHarnessState } from '@agimon-ai/doompi-config';
import { PI_CACHE_RETENTION_ENV } from '@agimon-ai/doompi-cache/env';
import { DOOMPI_EXTENSIONS_PROVIDED_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { DoomMcpProjection } from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SUBAGENT_TEAM_ID_ENV,
  SUBAGENT_TEAM_MAIN_MEMBER_ENV,
  SUBAGENT_TEAM_MEMBER_ID_ENV,
  SUBAGENT_TEAM_MEMBER_TOKEN_ENV,
  SUBAGENT_TEAM_ROOT_SESSION_ENV,
} from '../../src/exports/env';
import type { TeamRootContext } from '../../src/adapters/intercom/nativeTeamChannel';
import {
  type AsyncRunStatus,
  AsyncSubagentSpawner,
  type AsyncSubagentSpawnInput,
  runDirFor,
} from '../../src/adapters/runs/background/asyncExecution';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import type { SpawnHandshakeContract, SpawnHandshakeOutcome } from '../../src/adapters/runs/background/spawnHandshake';
import type {
  CoalescedStatusWriterContract,
  StatusWithRecentEntries,
} from '../../src/adapters/runs/background/statusWriter';
import type {
  TerminalPersistenceContract,
  TerminalTrigger,
} from '../../src/adapters/runs/background/terminalPersistence';
import type { BuildPiArgsInput, BuildPiArgsResult } from '../../src/adapters/runs/shared/piArgs';
import { TEMP_ARTIFACTS_DIR } from '../../src/adapters/filesystem/paths';

/** A status writer that records what was opened and flushed instead of touching disk. */
class RecordingStatusWriter implements CoalescedStatusWriterContract<AsyncRunStatus> {
  opened: { runId: string; initialStatus: AsyncRunStatus } | undefined;
  status: AsyncRunStatus = {} as AsyncRunStatus;
  readonly syncFlushes: AsyncRunStatus[] = [];

  open(runId: string, initialStatus: AsyncRunStatus): void {
    this.opened = { runId, initialStatus: { ...initialStatus } };
    this.status = initialStatus;
  }
  update(mutator: (status: AsyncRunStatus) => void): void {
    mutator(this.status);
  }
  updateSync(mutator: (status: AsyncRunStatus) => void): void {
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

/** A job tracker that records every `track()` call instead of touching disk. */
class FakeAsyncJobTracker implements AsyncJobTrackerContract {
  forSession() {
    return this;
  }
  trackedRunIds: string[] = [];
  track(runId: string): void {
    this.trackedRunIds.push(runId);
  }
  untrack(): void {}
  list(): TrackedAsyncJob[] {
    return [];
  }
  get(): TrackedAsyncJob | undefined {
    return undefined;
  }
  reset(): void {}
  start(): void {}
  stop(): void {}
}

/** A terminal persistence service that records tracked/untracked pids instead of touching disk. */
class FakeTerminalPersistenceService implements TerminalPersistenceContract {
  trackedPids: number[] = [];
  untrackedPids: number[] = [];
  begin(
    _runId: string,
    _mutate: (status: StatusWithRecentEntries, trigger: TerminalTrigger | undefined) => void,
  ): void {}
  trackChild(pid: number): void {
    this.trackedPids.push(pid);
  }
  untrackChild(pid: number): void {
    this.untrackedPids.push(pid);
  }
  finalize(): void {}
  dispose(): void {}
}

/** A handshake whose outcome for the next `waitForHandshake()` call is fully scripted. */
class FakeSpawnHandshake implements SpawnHandshakeContract {
  static nextOutcome: SpawnHandshakeOutcome = { status: 'signalled' };
  static lastPath: string | undefined;
  static cancelCalls = 0;

  waitForHandshake(options: { path: string; timeoutMs?: number }) {
    FakeSpawnHandshake.lastPath = options.path;
    return {
      promise: Promise.resolve(FakeSpawnHandshake.nextOutcome),
      cancel: () => {
        FakeSpawnHandshake.cancelCalls += 1;
      },
    };
  }
}

/**
 * Exposes the protected seams so a test can drive `spawn()` deterministically
 * without touching real `node:fs` or `node:child_process`.
 */
class TestAsyncSubagentSpawner extends AsyncSubagentSpawner {
  clock = 1000;
  writtenConfigs: Array<{ path: string; config: object }> = [];
  removedConfigPaths: string[] = [];
  spawnCalls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  /** Set to control what spawnChild() returns; defaults to a successful spawn. */
  spawnResult: { pid: number | undefined; errorToDeliver?: Error } = { pid: 4242 };
  exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  /** Set to control what readCurrentTeamRoot() returns; defaults to "not part of a team". */
  teamRoot: TeamRootContext | undefined;
  observedRunState: string | undefined;
  sdkExtensions: string[] = [];
  sdkExtensionsProvidedExternally = false;

  protected override now(): number {
    return this.clock;
  }

  protected override readCurrentTeamRoot(): TeamRootContext | undefined {
    return this.teamRoot;
  }

  protected override readRunState(): string | undefined {
    return this.observedRunState;
  }

  readonly writer = new RecordingStatusWriter();
  protected override createStatusWriter(): CoalescedStatusWriterContract<AsyncRunStatus> {
    return this.writer;
  }

  protected override createSpawnHandshake(): SpawnHandshakeContract {
    return new FakeSpawnHandshake();
  }

  protected override writeLaunchConfig(filePath: string, config: object): void {
    this.writtenConfigs.push({ path: filePath, config });
  }

  protected override removeLaunchConfig(filePath: string): void {
    this.removedConfigPaths.push(filePath);
  }

  buildLaunchArgsCalls: BuildPiArgsInput[] = [];
  /**
   * Bypasses `buildPiArgs`'s own real filesystem resolution (it locates a
   * runtime extension script on disk, which is environment-dependent and not
   * something a test of THIS module's orchestration logic should depend on).
   */
  protected override buildLaunchArgs(input: BuildPiArgsInput): BuildPiArgsResult {
    this.buildLaunchArgsCalls.push(input);
    return {
      args: ['--task', input.task],
      env: {},
      sdk: {
        extensions: this.sdkExtensions,
        extensionsProvidedExternally: this.sdkExtensionsProvidedExternally,
        noAmbientExtensions: false,
        skillPaths: [],
        noSkills: true,
        noContextFiles: true,
        sessionEnabled: false,
      },
    };
  }

  protected override spawnChild(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    const errorHandlers: Array<(error: Error) => void> = [];
    if (this.spawnResult.errorToDeliver) {
      const error = this.spawnResult.errorToDeliver;
      queueMicrotask(() => {
        for (const handler of errorHandlers) handler(error);
      });
    }
    return {
      pid: this.spawnResult.pid,
      onError: (handler: (error: Error) => void) => {
        errorHandlers.push(handler);
      },
      onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        this.exitHandlers.push(handler);
      },
    };
  }
}

function baseInput(overrides: Partial<AsyncSubagentSpawnInput> = {}): AsyncSubagentSpawnInput {
  return {
    runId: 'run-1',
    agent: 'worker',
    task: 'Implement the login form validation.',
    cwd: '/tmp/workspace',
    childIndex: 0,
    fanout: false,
    piArgs: { baseArgs: [], sessionEnabled: false, inheritProjectContext: false, inheritSkills: false },
    ...overrides,
  };
}

let jobTracker: FakeAsyncJobTracker;
let terminalPersistence: FakeTerminalPersistenceService;
let spawner: TestAsyncSubagentSpawner;

beforeEach(() => {
  FakeSpawnHandshake.nextOutcome = { status: 'signalled' };
  FakeSpawnHandshake.lastPath = undefined;
  FakeSpawnHandshake.cancelCalls = 0;
  jobTracker = new FakeAsyncJobTracker();
  terminalPersistence = new FakeTerminalPersistenceService();
  spawner = new TestAsyncSubagentSpawner(jobTracker, terminalPersistence);
});

describe('AsyncSubagentSpawner.spawn happy path', () => {
  it('returns the runId and pid once the handshake signals success', async () => {
    const result = await spawner.spawn(baseInput());

    expect(result).toEqual({ runId: 'run-1', pid: 4242 });
  });

  it('marks a run failed when its SDK runner is killed', async () => {
    await spawner.spawn(baseInput());

    spawner.exitHandlers[0]?.(null, 'SIGKILL');

    expect(spawner.writer.status).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('SIGKILL'),
      endedAt: 1000,
    });
    expect(jobTracker.trackedRunIds).toContain('run-1');
    expect(terminalPersistence.untrackedPids).toContain(4242);
  });

  it('does not overwrite a child that completed before the parent processed its ready handshake', async () => {
    spawner.observedRunState = 'complete';

    await spawner.spawn(baseInput());

    expect(spawner.writer.status.state).toBe('queued');
    expect(spawner.writer.syncFlushes).toEqual([]);
  });

  it('opens the status with state queued, then flushes it to running once started', async () => {
    await spawner.spawn(baseInput());

    expect(spawner.writer.opened?.initialStatus.state).toBe('queued');
    expect(spawner.writer.status.state).toBe('running');
  });

  it('persists the transcript path beside the parent session file', async () => {
    const parentSessionFile = '/home/u/.pi/agent/sessions/parent/transcript.jsonl';

    await spawner.spawn(
      baseInput({
        parentSessionFile,
        piArgs: {
          baseArgs: [],
          parentSessionId: 'parent-session-id',
          sessionEnabled: false,
          inheritProjectContext: false,
          inheritSkills: false,
        },
      }),
    );

    const initialStatus = spawner.writer.opened?.initialStatus;
    const launchConfig = spawner.writtenConfigs[0]?.config as { transcriptPath?: string };
    const expectedPath = path.join(
      path.dirname(parentSessionFile),
      'subagent-artifacts',
      'run-1_worker_transcript.jsonl',
    );
    expect(initialStatus?.transcriptPath).toBe(expectedPath);
    expect(launchConfig.transcriptPath).toBe(expectedPath);
  });

  it('falls back to the temporary artifact directory without a parent session file', async () => {
    await spawner.spawn(
      baseInput({
        piArgs: {
          baseArgs: [],
          parentSessionId: 'parent-session-id',
          sessionEnabled: false,
          inheritProjectContext: false,
          inheritSkills: false,
        },
      }),
    );

    expect(spawner.writer.opened?.initialStatus.transcriptPath).toBe(
      path.join(TEMP_ARTIFACTS_DIR, 'run-1_worker_transcript.jsonl'),
    );
  });

  it('persists the task, model, and inline definition needed for suspension recovery', async () => {
    await spawner.spawn(
      baseInput({
        inlineAgent: { systemPrompt: 'Inspect only.' },
        piArgs: {
          baseArgs: [],
          sessionEnabled: true,
          inheritProjectContext: false,
          inheritSkills: false,
          model: 'openai-codex/gpt-5.6-sol',
        },
      }),
    );

    expect(spawner.writer.opened?.initialStatus).toMatchObject({
      task: 'Implement the login form validation.',
      model: 'openai-codex/gpt-5.6-sol',
      inlineAgent: { systemPrompt: 'Inspect only.' },
    });
  });

  it('threads request-specific steering paths through buildPiArgs', async () => {
    await spawner.spawn(baseInput({ childIndex: 2 }));

    expect(spawner.buildLaunchArgsCalls[0]).toMatchObject({
      steerInboxDir: expect.stringContaining('/control/steer-targets/2'),
      steerCapabilityPath: expect.stringContaining('/control/steer-capabilities/2.json'),
      steerAckDir: expect.stringContaining('/control/steer-acks/2'),
    });
  });

  it('enables native team and task-board tools when the parent has a team root', async () => {
    spawner.teamRoot = {
      version: 1,
      teamId: 'team-1',
      rootSessionId: 'root-session-1',
      mainMemberId: 'main',
    };

    await spawner.spawn(baseInput());

    expect(spawner.buildLaunchArgsCalls[0]?.teamToolEnabled).toBe(true);
  });

  it('omits the child event transcript when artifacts are disabled', async () => {
    await spawner.spawn(baseInput({ artifacts: false }));

    const launchConfig = spawner.writtenConfigs[0]?.config as { transcriptPath?: string };
    expect(spawner.writer.opened?.initialStatus.transcriptPath).toBeUndefined();
    expect(launchConfig.transcriptPath).toBeUndefined();
  });

  it('tracks the child pid on the caller-supplied TerminalPersistenceService', async () => {
    await spawner.spawn(baseInput());

    expect(terminalPersistence.trackedPids).toEqual([4242]);
    expect(terminalPersistence.untrackedPids).toEqual([]);
  });

  it('registers the run with AsyncJobTracker once started', async () => {
    await spawner.spawn(baseInput());

    expect(jobTracker.trackedRunIds).toEqual(['run-1']);
  });

  it('waits on the handshake at the run-scoped handshake path', async () => {
    await spawner.spawn(baseInput());

    expect(FakeSpawnHandshake.lastPath).toContain('run-1');
    expect(FakeSpawnHandshake.lastPath).toMatch(/handshake\.json$/);
  });

  it('launches the detached SDK runner with the parent profile environment inherited', async () => {
    const key = 'DOOM_TEAM_TEST_PROFILE_VALUE';
    const previous = process.env[key];
    const previousRetention = process.env[PI_CACHE_RETENTION_ENV];
    process.env[key] = 'from-parent-profile';
    process.env[PI_CACHE_RETENTION_ENV] = 'long';
    try {
      await spawner.spawn(baseInput());

      expect(spawner.spawnCalls[0]?.command).toBe(process.execPath);
      expect(spawner.spawnCalls[0]?.args[0]).toMatch(/sdkRunnerEntry\.(?:ts|mjs)$/);
      expect(spawner.spawnCalls[0]?.env[key]).toBe('from-parent-profile');
      expect(spawner.spawnCalls[0]?.env[PI_CACHE_RETENTION_ENV]).toBe('long');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      if (previousRetention === undefined) delete process.env[PI_CACHE_RETENTION_ENV];
      else process.env[PI_CACHE_RETENTION_ENV] = previousRetention;
    }
  });
});

describe('AsyncSubagentSpawner launch config lifecycle (fix: predecessor left these at default mode and leaked them)', () => {
  it('writes the launch config once, before spawning', async () => {
    await spawner.spawn(baseInput());

    expect(spawner.writtenConfigs).toHaveLength(1);
  });

  it('removes the launch config once the handshake confirms the child read it', async () => {
    await spawner.spawn(baseInput());

    expect(spawner.removedConfigPaths).toEqual([spawner.writtenConfigs[0]!.path]);
  });

  it('removes the launch config when the spawn never produces a pid', async () => {
    spawner.spawnResult = { pid: undefined };

    await expect(spawner.spawn(baseInput())).rejects.toThrow(/did not produce a pid/);

    expect(spawner.removedConfigPaths).toEqual([spawner.writtenConfigs[0]!.path]);
  });

  it('removes the launch config when the handshake reports failure', async () => {
    FakeSpawnHandshake.nextOutcome = { status: 'failed', error: 'child exploded on startup' };

    await expect(spawner.spawn(baseInput())).rejects.toThrow('child exploded on startup');

    expect(spawner.removedConfigPaths).toEqual([spawner.writtenConfigs[0]!.path]);
  });

  it('the real (non-overridden) writeLaunchConfig writes 0600, not the umask default', () => {
    // Exercises the base implementation directly, against an isolated path,
    // rather than through spawn() (which uses the overridden seam above).
    const realSpawner = new AsyncSubagentSpawner(jobTracker, terminalPersistence) as unknown as {
      writeLaunchConfig: (filePath: string, config: object) => void;
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-async-execution-'));
    const filePath = path.join(tempDir, 'launch-config.json');

    try {
      realSpawner.writeLaunchConfig(filePath, { hello: 'world' });
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('AsyncSubagentSpawner failure handling', () => {
  it('throws with the spawn error when the child process errors before signalling', async () => {
    FakeSpawnHandshake.nextOutcome = { status: 'timed-out' };
    spawner.spawnResult = { pid: 4242, errorToDeliver: new Error('spawn ENOENT') };

    await expect(spawner.spawn(baseInput())).rejects.toThrow('spawn ENOENT');
  });

  it('falls back to a generic timeout message when there was no spawn error to report', async () => {
    FakeSpawnHandshake.nextOutcome = { status: 'timed-out' };

    await expect(spawner.spawn(baseInput())).rejects.toThrow(/Timed out waiting for 'worker'/);
  });

  it('untracks the pid on TerminalPersistenceService when the handshake does not signal', async () => {
    FakeSpawnHandshake.nextOutcome = { status: 'timed-out' };

    await expect(spawner.spawn(baseInput())).rejects.toThrow();

    expect(terminalPersistence.untrackedPids).toEqual([4242]);
  });

  it('marks the status failed with the error message on any failure', async () => {
    FakeSpawnHandshake.nextOutcome = { status: 'failed', error: 'boom' };

    await expect(spawner.spawn(baseInput())).rejects.toThrow('boom');

    expect(spawner.writer.status.state).toBe('failed');
    expect(spawner.writer.status.error).toBe('boom');
  });

  it('does not register the run with AsyncJobTracker on failure', async () => {
    FakeSpawnHandshake.nextOutcome = { status: 'failed', error: 'boom' };

    await expect(spawner.spawn(baseInput())).rejects.toThrow();

    expect(jobTracker.trackedRunIds).toEqual([]);
  });
});

describe('AsyncSubagentSpawner external profile security boundary', () => {
  const fableCeiling = {
    version: 2 as const,
    allowedTools: [],
    allowedExternalProfiles: ['claude/fable-plan-v1'],
    denyExtensions: true,
    sources: ['@agimon-ai/doompi-plan'],
  };

  it('denies a generic external launch whenever any capability ceiling is active', async () => {
    await expect(
      spawner.spawn(
        baseInput({
          runtime: 'claude',
          piArgs: {
            baseArgs: [],
            sessionEnabled: false,
            inheritProjectContext: false,
            inheritSkills: false,
            capabilityCeiling: fableCeiling,
          },
        }),
      ),
    ).rejects.toThrow("External profile 'none' is denied");
    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it('rejects caller-selected external profiles even without a ceiling', async () => {
    await expect(spawner.spawn(baseInput({ runtime: 'claude', externalProfile: 'caller/profile' }))).rejects.toThrow(
      "External profile 'caller/profile' is not trusted",
    );
  });

  it('requires the literal Claude runtime and Fable model for the trusted profile', async () => {
    await expect(
      spawner.spawn(
        baseInput({
          runtime: 'external',
          externalProfile: 'claude/fable-plan-v1',
          piArgs: {
            baseArgs: [],
            sessionEnabled: false,
            inheritProjectContext: false,
            inheritSkills: false,
            model: 'other',
            capabilityCeiling: fableCeiling,
          },
        }),
      ),
    ).rejects.toThrow('requires runtime claude and model fable');
  });

  it.each([
    ['inline agent', { inlineAgent: { systemPrompt: 'unsafe' } }],
    ['session file', { piArgs: { sessionFile: '/parent/session.jsonl' } }],
    ['parent session', { piArgs: { parentSessionId: 'parent-session' } }],
  ])('rejects inherited %s context before preparing a Fable launch', async (_label, override) => {
    await expect(
      spawner.spawn(
        baseInput({
          runtime: 'claude',
          externalProfile: 'claude/fable-plan-v1',
          piArgs: {
            baseArgs: [],
            sessionEnabled: false,
            inheritProjectContext: false,
            inheritSkills: false,
            model: 'fable',
            capabilityCeiling: fableCeiling,
            ...('piArgs' in override ? override.piArgs : {}),
          },
          ...('inlineAgent' in override ? { inlineAgent: override.inlineAgent } : {}),
        }),
      ),
    ).rejects.toThrow('requires a fresh isolated context');
  });
});

describe('AsyncSubagentSpawner team membership env forwarding (fix: a spawned child had no way to join the team)', () => {
  const fakeRoot: TeamRootContext = {
    version: 1,
    teamId: 'team-1',
    rootSessionId: 'root-session-1',
    mainMemberId: 'main',
  };

  it('forwards the team root env vars to the child when this process is itself part of a team', async () => {
    spawner.teamRoot = fakeRoot;

    await spawner.spawn(baseInput());

    expect(spawner.spawnCalls[0]?.env).toMatchObject({
      [SUBAGENT_TEAM_ID_ENV]: 'team-1',
      [SUBAGENT_TEAM_ROOT_SESSION_ENV]: 'root-session-1',
      [SUBAGENT_TEAM_MAIN_MEMBER_ENV]: 'main',
    });
  });

  it('never forwards a member id or token - those are per-member secrets the child mints for itself', async () => {
    spawner.teamRoot = fakeRoot;

    await spawner.spawn(baseInput());

    expect(spawner.spawnCalls[0]?.env[SUBAGENT_TEAM_MEMBER_ID_ENV]).toBeUndefined();
    expect(spawner.spawnCalls[0]?.env[SUBAGENT_TEAM_MEMBER_TOKEN_ENV]).toBeUndefined();
  });

  it('forwards nothing when this process has no team root (a standalone spawn outside any team)', async () => {
    spawner.teamRoot = undefined;
    const names = [SUBAGENT_TEAM_ID_ENV, SUBAGENT_TEAM_ROOT_SESSION_ENV, SUBAGENT_TEAM_MAIN_MEMBER_ENV];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];

    try {
      await spawner.spawn(baseInput());

      expect(spawner.spawnCalls[0]?.env[SUBAGENT_TEAM_ID_ENV]).toBeUndefined();
      expect(spawner.spawnCalls[0]?.env[SUBAGENT_TEAM_ROOT_SESSION_ENV]).toBeUndefined();
      expect(spawner.spawnCalls[0]?.env[SUBAGENT_TEAM_MAIN_MEMBER_ENV]).toBeUndefined();
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('the launch config the child later reads carries the same forwarded env', async () => {
    spawner.teamRoot = fakeRoot;

    await spawner.spawn(baseInput());

    const config = spawner.writtenConfigs[0]?.config as { env: Record<string, string | undefined> };
    expect(config.env[SUBAGENT_TEAM_ID_ENV]).toBe('team-1');
  });

  it('projects the resolved Pi 0.84 SDK extensions into the detached child harness', async () => {
    spawner.sdkExtensions = ['/doom/layer-marker.mjs'];

    await spawner.spawn(baseInput());

    expect(spawner.spawnCalls[0]?.env.DOOMPI_CHILD_EXTENSIONS).toBe('["/doom/layer-marker.mjs"]');
  });

  it('rebases the inherited MCP staging directory into the detached child run', async () => {
    const projection: DoomMcpProjection = {
      version: 1,
      enabled: true,
      fingerprint: 'parent-projection-fingerprint',
      repoRoot: '/repo',
      stagingDirectory: '/parent/run/mcp-staging',
      sources: [
        {
          sourceId: 'repository:mcp',
          owner: 'repository',
          format: 'native',
          configPath: '/repo/.mcp.json',
          contentDigest: 'native-source-digest',
        },
      ],
    };
    updateHarnessState({ mcpProjection: projection });

    await spawner.spawn(baseInput());

    const childStatePath = spawner.spawnCalls[0]?.env[HARNESS_STATE_POINTER];
    expect(childStatePath).toBe(path.join(runDirFor('run-1'), 'harness-state.json'));
    const childState = JSON.parse(fs.readFileSync(childStatePath!, 'utf8')) as {
      state: { mcpProjection?: DoomMcpProjection };
    };
    expect(childState.state.mcpProjection).toEqual({
      ...projection,
      stagingDirectory: runDirFor('run-1'),
    });
    expect(childState.state.mcpProjection?.fingerprint).toBe(projection.fingerprint);
    expect(childState.state.mcpProjection?.sources).toEqual(projection.sources);
  });

  it('marks an SDK child whose complete Doom extension set was supplied explicitly', async () => {
    spawner.sdkExtensionsProvidedExternally = true;

    await spawner.spawn(baseInput());

    expect(spawner.spawnCalls[0]?.env[DOOMPI_EXTENSIONS_PROVIDED_ENV]).toBe('1');
  });
});
