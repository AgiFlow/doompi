import type { ComputerUseState, ComputerUseStateEvent } from '../types/computerUse.ts';

function requireRequest(state: ComputerUseState, requestId: string): void {
  if (state.requestId !== requestId) throw new Error('The computer-use activation request is stale.');
}

function next(state: ComputerUseState, patch: Omit<ComputerUseState, 'revision' | 'identity'>): ComputerUseState {
  return {
    revision: state.revision + 1,
    identity: state.identity,
    ...patch,
  };
}

export function initialComputerUseState(identity: ComputerUseState['identity']): ComputerUseState {
  return { revision: 0, phase: 'inactive', identity };
}

export function reduceComputerUseState(state: ComputerUseState, event: ComputerUseStateEvent): ComputerUseState {
  if (event.type === 'fail') {
    return next(state, {
      phase: 'failed',
      failure: { code: event.code, message: event.message },
      ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
      ...(state.target === undefined ? {} : { target: state.target }),
      ...(state.grant === undefined ? {} : { grant: state.grant }),
    });
  }

  if (event.type === 'reset') {
    if (state.phase !== 'failed') throw new Error('Only a failed computer-use state can be reset.');
    return next(state, { phase: 'inactive' });
  }

  switch (state.phase) {
    case 'inactive': {
      if (event.type !== 'request') throw new Error('Computer use is inactive.');
      return next(state, {
        phase: 'requesting',
        requestId: event.requestId,
        target: event.target,
      });
    }
    case 'requesting': {
      if (event.type !== 'await_confirmation') throw new Error('Computer use is preparing an activation request.');
      requireRequest(state, event.requestId);
      return next(state, {
        phase: 'awaiting_confirmation',
        requestId: event.requestId,
        target: state.target,
      });
    }
    case 'awaiting_confirmation': {
      if (event.type === 'deny') {
        requireRequest(state, event.requestId);
        return next(state, { phase: 'inactive' });
      }
      if (event.type !== 'confirm') throw new Error('Computer use is waiting for confirmation.');
      requireRequest(state, event.requestId);
      return next(state, {
        phase: 'activating',
        requestId: event.requestId,
        target: state.target,
      });
    }
    case 'activating': {
      if (event.type !== 'activated') throw new Error('Computer use is activating.');
      requireRequest(state, event.requestId);
      return next(state, {
        phase: 'active',
        requestId: event.requestId,
        target: state.target,
        grant: event.grant,
      });
    }
    case 'active': {
      if (event.type !== 'stop') throw new Error('Computer use is active.');
      return next(state, {
        phase: 'stopping',
        requestId: state.requestId,
        target: state.target,
        grant: state.grant,
      });
    }
    case 'stopping': {
      if (event.type !== 'stopped') throw new Error('Computer use is stopping.');
      return next(state, { phase: 'inactive' });
    }
    case 'failed':
      throw new Error('Computer use must be reset before another transition.');
  }
}
