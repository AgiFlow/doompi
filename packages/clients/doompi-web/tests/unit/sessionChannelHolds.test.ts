import { describe, expect, it, vi } from 'vitest';

import {
  dispatchHeldSessionChannel,
  heldSessionChannels,
  holdSessionChannels,
} from '../../src/web/stores/sessionChannelHoldsStore';

describe('unfocused session channel ownership', () => {
  it('retains other observers and releases each hold only once', () => {
    const first = holdSessionChannels('s2');
    const second = holdSessionChannels('s2');
    const other = holdSessionChannels('s3');
    expect(heldSessionChannels.state.get('s2')).toBe(2);
    first();
    first();
    expect(heldSessionChannels.state.get('s2')).toBe(1);
    second();
    expect(heldSessionChannels.state.has('s2')).toBe(false);
    expect(heldSessionChannels.state.get('s3')).toBe(1);
    other();
    expect(heldSessionChannels.state.size).toBe(0);
  });

  it('delivers unfocused target results only to its observers and stops after release', () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = holdSessionChannels('s2', first);
    const releaseSecond = holdSessionChannels('s3', second);
    const frame = { type: 'git_worktrees', sessionId: 's2', payload: { error: 'not a repository' } };
    try {
      dispatchHeldSessionChannel(frame);
      expect(first).toHaveBeenCalledWith(frame);
      expect(second).not.toHaveBeenCalled();
      releaseFirst();
      dispatchHeldSessionChannel(frame);
      expect(first).toHaveBeenCalledTimes(1);
      dispatchHeldSessionChannel({ ...frame, sessionId: 's3' });
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });

  it('keeps other holds when the same observer is registered twice', () => {
    const receive = vi.fn();
    const first = holdSessionChannels('s2', receive);
    const second = holdSessionChannels('s2', receive);
    try {
      first();
      first();
      dispatchHeldSessionChannel({ type: 'git_worktrees', sessionId: 's2', payload: {} });
      expect(receive).toHaveBeenCalledTimes(1);
    } finally {
      first();
      second();
    }
    expect(heldSessionChannels.state.size).toBe(0);
  });
});
