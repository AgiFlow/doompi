import { afterEach, describe, expect, it, vi } from 'vitest';

import { AsyncJobTracker } from '../../src/services/asyncJobTracker';
import { ManagementActions } from '../../src/services/managementActions';
import type { NativeRunCoordinatorContract } from '../../src/services/nativeRunCoordinator';
import {
  EXTERNAL_IPC_CHANNEL,
  EXTERNAL_IPC_VERSION,
  type ExternalProcessEndpoint,
  ExternalProcessIpc,
  type ExternalControlMessage,
  type ExternalRunProjection,
} from '../../src/services/externalProcessIpc';
import { createSessionScope, type SessionScope } from '../../src/services/sessionPaths';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';
import type { DoomChildSessionHandle } from '@agimon-ai/doompi-core/child';

const trackers: AsyncJobTracker[] = [];
const externalIpcs: ExternalProcessIpc[] = [];

afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.stop();
  for (const ipc of externalIpcs.splice(0)) ipc.close();
});

function makeActions(
  scope: SessionScope = TEST_SESSION_SCOPE,
  tracker = new AsyncJobTracker(),
  nativeRuns?: NativeRunCoordinatorContract,
  externalProcesses?: ExternalProcessIpc,
) {
  trackers.push(tracker);
  const actions = new ManagementActions(tracker, nativeRuns, externalProcesses);
  actions.bindSessionScope(scope);
  return { actions, tracker };
}

function externalProjection(runId: string, state = 'running'): ExternalRunProjection {
  return {
    runId,
    agent: 'worker',
    task: 'inspect',
    cwd: '/work',
    runtime: 'claude',
    state,
    startedAt: 10,
    updatedAt: 20,
  };
}

function nativeProjection(runId: string, status = 'running') {
  return {
    runId,
    agent: 'worker',
    task: 'inspect',
    cwd: '/work',
    runtime: 'pi',
    status,
    startedAt: 10,
    updatedAt: 20,
  } as const;
}

function fakeNativeRuns(activeRunId = 'native-run') {
  const native = {
    start: vi.fn(),
    get: vi.fn((_sessionId: string, runId: string): DoomChildSessionHandle | undefined =>
      runId === activeRunId ? ({} as DoomChildSessionHandle) : undefined,
    ),
    status: vi.fn(),
    steer: vi.fn(async (_sessionId: string, _runId: string, _message: string, _signal?: AbortSignal) => undefined),
    stop: vi.fn(async (_sessionId: string, _runId: string, _reason?: string) => undefined),
    close: vi.fn(async () => undefined),
  } satisfies NativeRunCoordinatorContract;
  return native;
}

function fakeExternalEndpoint(runId: string, scope: SessionScope) {
  const sent: object[] = [];
  let receive: ((message: unknown) => void) | undefined;
  const endpoint: ExternalProcessEndpoint = {
    onMessage(handler) {
      receive = handler;
      return () => {
        receive = undefined;
      };
    },
    onExit() {
      return () => undefined;
    },
    send: vi.fn(async (message: object) => {
      sent.push(message);
      const control = message as Partial<ExternalControlMessage>;
      if (control.command === 'steer' && control.requestId) {
        receive?.({
          channel: EXTERNAL_IPC_CHANNEL,
          version: EXTERNAL_IPC_VERSION,
          direction: 'runner',
          kind: 'ack',
          runId,
          scopeKey: scope.scopeKey,
          requestId: control.requestId,
          command: 'steer',
          state: 'delivered',
          message: 'External child accepted the steer request.',
        });
      }
    }),
    disconnect: vi.fn(),
  };
  return { endpoint, sent };
}

describe('ManagementActions', () => {
  it('resolves exact and unique prefixes from current-session projections', () => {
    const { actions, tracker } = makeActions();
    tracker.upsertExternal(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, externalProjection('run-123'));

    expect(actions.status('run-123').runId).toBe('run-123');
    expect(actions.status('run-1').runId).toBe('run-123');
    expect(actions.status('run-1').status).toMatchObject({ state: 'running', runtime: 'claude' });
  });

  it('prefers an exact run over a matching prefix and rejects ambiguous prefixes', () => {
    const { actions, tracker } = makeActions();
    tracker.upsertExternal(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, externalProjection('run-1'));
    tracker.upsertExternal(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, externalProjection('run-123'));

    expect(actions.status('run-1').runId).toBe('run-1');
    expect(() => actions.status('run-')).toThrow(/Multiple current-session runs match 'run-'/);
  });

  it('keeps status and list projections isolated by session scope', () => {
    const otherScope = createSessionScope('other-session');
    const tracker = new AsyncJobTracker();
    const { actions } = makeActions(TEST_SESSION_SCOPE, tracker);
    const { actions: otherActions } = makeActions(otherScope, tracker);
    tracker.upsertExternal(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, externalProjection('owned-run'));
    tracker.upsertExternal(otherScope.rootSessionId, otherScope, externalProjection('foreign-run'));

    expect(actions.list().runs.map((run) => run.runId)).toEqual(['owned-run']);
    expect(actions.status('foreign-run')).toEqual({
      runId: 'foreign-run',
      runDir: undefined,
      resultPath: undefined,
      claimed: false,
      status: undefined,
    });
    expect(otherActions.status('foreign-run').status).toMatchObject({ runId: 'foreign-run' });
  });

  it('projects native status and routes stop and steer through the typed coordinator', async () => {
    const native = fakeNativeRuns();
    const { actions, tracker } = makeActions(TEST_SESSION_SCOPE, new AsyncJobTracker(), native);
    tracker.upsertNative(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, nativeProjection('native-run'));

    expect(actions.status('native-run').status).toMatchObject({
      runId: 'native-run',
      state: 'running',
      runtime: 'pi',
      startedAt: 10,
      lastUpdate: 20,
    });

    const stop = await actions.stop('native-run', 'no longer needed');
    const signal = new AbortController().signal;
    const steer = await actions.steer('native-run', 'continue', 2, signal);

    expect(stop).toEqual({ requestId: expect.any(String) });
    expect(steer).toMatchObject({
      requestId: expect.any(String),
      index: 2,
      state: 'delivered',
      message: 'Native child accepted the steer request.',
    });
    expect(native.stop).toHaveBeenCalledWith(TEST_SESSION_SCOPE.rootSessionId, 'native-run', 'no longer needed');
    expect(native.steer).toHaveBeenCalledWith(TEST_SESSION_SCOPE.rootSessionId, 'native-run', 'continue', signal);
  });

  it('routes external stop and acknowledged steer through ExternalProcessIpc', async () => {
    const ipc = new ExternalProcessIpc();
    externalIpcs.push(ipc);
    const { endpoint, sent } = fakeExternalEndpoint('external-run', TEST_SESSION_SCOPE);
    ipc.register(TEST_SESSION_SCOPE, 'external-run', endpoint);
    const { actions, tracker } = makeActions(TEST_SESSION_SCOPE, new AsyncJobTracker(), undefined, ipc);
    tracker.upsertExternal(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, externalProjection('external-run'));

    const stop = await actions.stop('external-run', 'cancelled');
    const steer = await actions.steer('external-run', 'try another path', 1);

    expect(stop.requestId).toEqual(expect.any(String));
    expect(sent[0]).toMatchObject({
      kind: 'control',
      command: 'stop',
      runId: 'external-run',
      reason: 'cancelled',
      requestId: stop.requestId,
    });
    expect(steer).toMatchObject({
      requestId: expect.any(String),
      index: 1,
      state: 'delivered',
      message: 'External child accepted the steer request.',
    });
    expect(sent[1]).toMatchObject({
      kind: 'control',
      command: 'steer',
      message: 'try another path',
      targetIndex: 1,
      requestId: steer.requestId,
    });
  });

  it('resolves a unique prefix for external control', async () => {
    const ipc = new ExternalProcessIpc();
    externalIpcs.push(ipc);
    const { endpoint, sent } = fakeExternalEndpoint('external-prefix-run', TEST_SESSION_SCOPE);
    ipc.register(TEST_SESSION_SCOPE, 'external-prefix-run', endpoint);
    const { actions, tracker } = makeActions(TEST_SESSION_SCOPE, new AsyncJobTracker(), undefined, ipc);
    tracker.upsertExternal(
      TEST_SESSION_SCOPE.rootSessionId,
      TEST_SESSION_SCOPE,
      externalProjection('external-prefix-run'),
    );

    await actions.stop('external-prefix', 'prefix control');

    expect(sent[0]).toMatchObject({ runId: 'external-prefix-run', command: 'stop' });
  });

  it('reports missing projections and controls without touching a filesystem channel', async () => {
    const native = fakeNativeRuns('different-run');
    const ipc = new ExternalProcessIpc();
    externalIpcs.push(ipc);
    const { actions, tracker } = makeActions(TEST_SESSION_SCOPE, new AsyncJobTracker(), native, ipc);

    await expect(actions.stop('missing-run')).rejects.toThrow(/\[run_not_found\].*No active run matches 'missing-run'/);
    await expect(actions.steer('missing-run', 'continue')).rejects.toThrow(/\[run_not_found\]/);

    tracker.upsertNative(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, nativeProjection('native-gone'));
    await expect(actions.stop('native-gone')).rejects.toThrow(/Native run 'native-gone' is no longer active/);

    tracker.upsertExternal(TEST_SESSION_SCOPE.rootSessionId, TEST_SESSION_SCOPE, externalProjection('external-gone'));
    await expect(actions.stop('external-gone')).rejects.toThrow(/External run 'external-gone' is no longer active/);
  });
});
