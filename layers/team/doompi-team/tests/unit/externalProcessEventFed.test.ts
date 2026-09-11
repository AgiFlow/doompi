import { describe, expect, it, vi } from 'vitest';

import { AsyncJobTracker } from '../../src/adapters/asyncJobTracker';
import { createSessionScope } from '../../src/adapters/filesystem/paths';
import {
  ExternalProcessIpc,
  type ExternalProcessEndpoint,
  type ExternalRunnerStatusMessage,
} from '../../src/adapters/process/externalProcessIpc';

const scope = createSessionScope('session-event-fed');

function status(runId: string, state: string): ExternalRunnerStatusMessage {
  return {
    channel: 'doompi-team-external',
    version: 1,
    direction: 'runner',
    kind: 'status',
    runId,
    scopeKey: scope.scopeKey,
    status: {
      runId,
      agent: 'worker',
      task: 'task',
      cwd: '/repo',
      runtime: 'claude',
      state,
      startedAt: 1,
      updatedAt: Date.now(),
    },
  };
}

function endpoint(): {
  endpoint: ExternalProcessEndpoint;
  emitMessage(message: unknown): void;
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
} {
  let messageHandler: ((message: unknown) => void) | undefined;
  let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  return {
    endpoint: {
      onMessage(handler) {
        messageHandler = handler;
        return () => {
          messageHandler = undefined;
        };
      },
      onExit(handler) {
        exitHandler = handler;
        return () => {
          exitHandler = undefined;
        };
      },
      send: vi.fn(async () => undefined),
    },
    emitMessage: (message) => messageHandler?.(message),
    emitExit: (code, signal) => exitHandler?.(code, signal),
  };
}

describe('event-fed external Team runs', () => {
  it('updates the session tracker from typed IPC status and result events', () => {
    const tracker = new AsyncJobTracker();
    const jobs = tracker.forSession(scope.rootSessionId, scope);
    const ipc = new ExternalProcessIpc();
    const child = endpoint();
    ipc.register(scope, 'run-1', child.endpoint);
    const unsubscribe = ipc.subscribe((event) => {
      if (!('message' in event)) return;
      if (event.message.kind === 'status')
        tracker.upsertExternal(scope.rootSessionId, event.scope, event.message.status);
      if (event.message.kind === 'result') {
        tracker.acceptExternalResult(scope.rootSessionId, event.scope, event.message.runId, event.message.result);
      }
    });

    child.emitMessage(status('run-1', 'running'));
    expect(jobs.get('run-1')).toMatchObject({ agent: 'worker', status: 'running', runtime: 'claude' });

    child.emitMessage({
      channel: 'doompi-team-external',
      version: 1,
      direction: 'runner',
      kind: 'result',
      runId: 'run-1',
      scopeKey: scope.scopeKey,
      result: { success: true, summary: 'done' },
    });
    expect(jobs.get('run-1')).toMatchObject({ status: 'completed', summary: 'done' });

    unsubscribe();
    ipc.close();
  });

  it('turns an unexpected external process exit into a terminal event', () => {
    const tracker = new AsyncJobTracker();
    const jobs = tracker.forSession(scope.rootSessionId, scope);
    tracker.upsertExternal(scope.rootSessionId, scope, status('run-2', 'running').status);
    const ipc = new ExternalProcessIpc();
    const child = endpoint();
    ipc.register(scope, 'run-2', child.endpoint);
    const unsubscribe = ipc.subscribe((event) => {
      if ('message' in event) return;
      const job = jobs.get(event.runId);
      if (!job || job.status === 'completed') return;
      tracker.markExternalFailed(scope.rootSessionId, event.scope, event.runId, 'runner exited');
    });

    child.emitExit(1, null);
    expect(jobs.get('run-2')).toMatchObject({ status: 'failed', error: 'runner exited' });

    unsubscribe();
    ipc.close();
  });
});
