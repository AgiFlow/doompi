import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpawnHandshake, type SpawnHandshakeOutcome } from '../../src/adapters/runs/background/spawnHandshake';
import {
  EXTERNAL_IPC_CHANNEL,
  EXTERNAL_IPC_VERSION,
  type ExternalProcessEndpoint,
} from '../../src/adapters/process/externalProcessIpc';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';

function endpoint(): {
  endpoint: ExternalProcessEndpoint;
  emit: (message: unknown) => void;
  listenerCount: () => number;
} {
  const messageHandlers = new Set<(message: unknown) => void>();
  return {
    endpoint: {
      onMessage(handler) {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      onExit() {
        return () => undefined;
      },
      send: async () => undefined,
    },
    emit: (message) => {
      for (const handler of messageHandlers) handler(message);
    },
    listenerCount: () => messageHandlers.size,
  };
}

function readyMessage(runId = 'run-1', scopeKey = TEST_SESSION_SCOPE.scopeKey): object {
  return {
    channel: EXTERNAL_IPC_CHANNEL,
    version: EXTERNAL_IPC_VERSION,
    direction: 'runner',
    kind: 'ready',
    runId,
    scopeKey,
  };
}

function errorMessage(error = 'vendor failed to start'): object {
  return {
    ...readyMessage(),
    kind: 'error',
    error,
  };
}

function waitForHandshake(
  child: ExternalProcessEndpoint,
  timeoutMs = 100,
): ReturnType<SpawnHandshake['waitForHandshake']> {
  return new SpawnHandshake().waitForHandshake({
    child,
    runId: 'run-1',
    scopeKey: TEST_SESSION_SCOPE.scopeKey,
    timeoutMs,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SpawnHandshake Node IPC readiness', () => {
  it('resolves when the external runner sends a matching ready message', async () => {
    const child = endpoint();
    const wait = waitForHandshake(child.endpoint);

    child.emit(readyMessage());

    await expect(wait.promise).resolves.toEqual<SpawnHandshakeOutcome>({ status: 'signalled' });
    expect(child.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores malformed or mismatched messages until the matching readiness signal arrives', async () => {
    const child = endpoint();
    const wait = waitForHandshake(child.endpoint);

    child.emit({ kind: 'ready' });
    child.emit(readyMessage('other-run'));
    child.emit(readyMessage('run-1', 'other-scope'));
    expect(child.listenerCount()).toBe(1);

    child.emit(readyMessage());

    await expect(wait.promise).resolves.toEqual({ status: 'signalled' });
  });

  it('resolves a runner-reported failure with its error and tears down the listener', async () => {
    const child = endpoint();
    const wait = waitForHandshake(child.endpoint);

    child.emit(errorMessage('missing external binary'));

    await expect(wait.promise).resolves.toEqual<SpawnHandshakeOutcome>({
      status: 'failed',
      error: 'missing external binary',
    });
    expect(child.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SpawnHandshake bounded lifetime', () => {
  it('resolves timed-out when no runner readiness or failure arrives before the bound', async () => {
    const child = endpoint();
    const wait = waitForHandshake(child.endpoint, 25);

    await vi.advanceTimersByTimeAsync(25);

    await expect(wait.promise).resolves.toEqual<SpawnHandshakeOutcome>({ status: 'timed-out' });
    expect(child.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the wait with an error and removes its IPC listener', async () => {
    const child = endpoint();
    const wait = waitForHandshake(child.endpoint);

    wait.cancel('external process exited before readiness');

    await expect(wait.promise).rejects.toThrow('external process exited before readiness');
    expect(child.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not change a settled readiness result when cancellation races afterward', async () => {
    const child = endpoint();
    const wait = waitForHandshake(child.endpoint);

    child.emit(readyMessage());
    await expect(wait.promise).resolves.toEqual({ status: 'signalled' });

    expect(() => wait.cancel('too late')).not.toThrow();
    await expect(wait.promise).resolves.toEqual({ status: 'signalled' });
  });
});
