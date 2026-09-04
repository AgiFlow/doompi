import { describe, expect, it } from 'vitest';
import { computerUse, computerUseChannel } from '../../src/web/computerUseStore.ts';

const payload = (sessionId: string, phase: 'inactive' | 'active') => ({
  state: { sessionId, revision: 1, wake: 1, phase },
  targets: [{ windowId: 'w1', applicationName: 'Fixture' }],
});

describe('computer-use web store channel', () => {
  it('keeps state session scoped and rejects malformed payloads', () => {
    computerUse.reset();
    computerUseChannel.apply('s1', computerUseChannel.parse(payload('s1', 'active'))!);
    computerUseChannel.apply('s2', computerUseChannel.parse(payload('s2', 'inactive'))!);
    expect(computerUse.select(computerUse.store.state, 's1').state.phase).toBe('active');
    expect(computerUse.select(computerUse.store.state, 's2').state.phase).toBe('inactive');
    expect(computerUseChannel.parse({ state: {}, targets: [] })).toBeNull();
    computerUseChannel.drop('s1');
    expect(computerUse.store.state.s1).toBeUndefined();
  });
});
