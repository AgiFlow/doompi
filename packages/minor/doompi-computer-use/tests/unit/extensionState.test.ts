import { describe, expect, it } from 'vitest';
import { computerUseRestriction, modeState } from '../../src/models/computerUseMode';
import type { ComputerUseSessionView } from '../../src/types/computerUseApi';

function state(phase: ComputerUseSessionView['phase']): ComputerUseSessionView {
  return { sessionId: 'session-1', revision: 1, wake: 1, phase };
}

describe('computer-use Pi runtime projection', () => {
  it.each([
    ['inactive', 'inactive', 'ready'],
    ['awaiting_confirmation', 'activating', 'blocked'],
    ['activating', 'activating', 'queued'],
    ['active', 'active', 'ready'],
    ['stopping', 'deactivating', 'queued'],
    ['failed', 'inactive', 'failed'],
  ] as const)('projects %s mode state', (phase, activation, condition) => {
    expect(modeState(state(phase))).toMatchObject({ activation, condition });
  });

  it('projects an enabled setup state without activating the grant-gated tools', () => {
    const projected = modeState(state('inactive'), true);
    expect(projected).toMatchObject({ activation: 'active', condition: 'ready' });
    expect(projected.detail).toContain('Activity');
    expect(projected.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'activate', enabled: false }),
        expect.objectContaining({ id: 'deactivate', enabled: true }),
      ]),
    );
  });
  it('hides the computer-use tools while the mode is off and leaves the rest alone', () => {
    const available = ['read', 'computer_state', 'computer_action', 'computer_exec'];
    expect(computerUseRestriction(false)(available, available)).toEqual(['read']);
    expect(computerUseRestriction(true)(available, available)).toEqual(available);
  });
});
