import { describe, expect, it } from 'vitest';
import { initialComputerUseState, reduceComputerUseState } from '../../../src/services/sessionController.ts';
import type { ComputerUseGrant, ComputerUseTarget } from '../../../src/types/computerUse.ts';

const identity = { sessionId: 'session-a', runtimeId: 'runtime-a', modeEpoch: 'mode-a' };
const target: ComputerUseTarget = {
  bundleId: 'com.example.fixture',
  applicationName: 'Fixture',
  processId: 42,
  windowId: 'window-1',
  windowTitle: 'Fixture Window',
};
const grant: ComputerUseGrant = {
  runId: 'run-1',
  grantId: 'grant-1',
  hostGeneration: 'host-1',
  targetGeneration: 'target-1',
  expiresAt: 1000,
};

describe('computer-use session state', () => {
  it('moves through confirmation, activation, and stop without changing ownership', () => {
    let state = initialComputerUseState(identity);
    state = reduceComputerUseState(state, { type: 'request', requestId: 'request-1', target });
    state = reduceComputerUseState(state, { type: 'await_confirmation', requestId: 'request-1' });
    state = reduceComputerUseState(state, { type: 'confirm', requestId: 'request-1' });
    state = reduceComputerUseState(state, { type: 'activated', requestId: 'request-1', grant });

    expect(state).toMatchObject({ phase: 'active', identity, target, grant, revision: 4 });

    state = reduceComputerUseState(state, { type: 'stop' });
    state = reduceComputerUseState(state, { type: 'stopped' });
    expect(state).toEqual({ phase: 'inactive', identity, revision: 6 });
  });

  it('rejects a stale confirmation request', () => {
    let state = initialComputerUseState(identity);
    state = reduceComputerUseState(state, { type: 'request', requestId: 'request-1', target });
    state = reduceComputerUseState(state, { type: 'await_confirmation', requestId: 'request-1' });

    expect(() => reduceComputerUseState(state, { type: 'confirm', requestId: 'request-2' })).toThrow(/stale/u);
  });

  it('releases state after denial', () => {
    let state = initialComputerUseState(identity);
    state = reduceComputerUseState(state, { type: 'request', requestId: 'request-1', target });
    state = reduceComputerUseState(state, { type: 'await_confirmation', requestId: 'request-1' });
    state = reduceComputerUseState(state, { type: 'deny', requestId: 'request-1' });

    expect(state).toEqual({ phase: 'inactive', identity, revision: 3 });
  });

  it('requires an explicit reset after failure', () => {
    let state = initialComputerUseState(identity);
    state = reduceComputerUseState(state, { type: 'fail', code: 'desktop_unavailable', message: 'Open Desktop.' });

    expect(state.phase).toBe('failed');
    expect(() => reduceComputerUseState(state, { type: 'request', requestId: 'request-1', target })).toThrow(/reset/u);
    expect(reduceComputerUseState(state, { type: 'reset' })).toEqual({ phase: 'inactive', identity, revision: 2 });
  });

  it('rejects invalid events in every lifecycle phase', () => {
    let state = initialComputerUseState(identity);
    expect(() => reduceComputerUseState(state, { type: 'stop' })).toThrow(/inactive/u);
    expect(() => reduceComputerUseState(state, { type: 'reset' })).toThrow(/failed/u);
    state = reduceComputerUseState(state, { type: 'request', requestId: 'request-1', target });
    expect(() => reduceComputerUseState(state, { type: 'stop' })).toThrow(/preparing/u);
    state = reduceComputerUseState(state, { type: 'await_confirmation', requestId: 'request-1' });
    expect(() => reduceComputerUseState(state, { type: 'stop' })).toThrow(/waiting/u);
    state = reduceComputerUseState(state, { type: 'confirm', requestId: 'request-1' });
    expect(() => reduceComputerUseState(state, { type: 'stop' })).toThrow(/activating/u);
    state = reduceComputerUseState(state, { type: 'activated', requestId: 'request-1', grant });
    expect(() => reduceComputerUseState(state, { type: 'request', requestId: 'request-2', target })).toThrow(/active/u);
    state = reduceComputerUseState(state, { type: 'stop' });
    expect(() => reduceComputerUseState(state, { type: 'request', requestId: 'request-2', target })).toThrow(
      /stopping/u,
    );
    state = reduceComputerUseState(state, { type: 'fail', code: 'internal_error', message: 'failed' });
    expect(() => reduceComputerUseState(state, { type: 'stop' })).toThrow(/reset/u);
  });

  it('retains the bounded activation context when an active run fails', () => {
    let state = initialComputerUseState(identity);
    state = reduceComputerUseState(state, { type: 'request', requestId: 'request-1', target });
    state = reduceComputerUseState(state, { type: 'await_confirmation', requestId: 'request-1' });
    state = reduceComputerUseState(state, { type: 'confirm', requestId: 'request-1' });
    state = reduceComputerUseState(state, { type: 'activated', requestId: 'request-1', grant });
    expect(reduceComputerUseState(state, { type: 'fail', code: 'target_lost', message: 'gone' })).toMatchObject({
      phase: 'failed',
      requestId: 'request-1',
      target,
      grant,
    });
  });
});
