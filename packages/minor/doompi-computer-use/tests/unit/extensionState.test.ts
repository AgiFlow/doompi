import { describe, expect, it, vi } from 'vitest';
import { modeState, reconcileTools } from '../../src/adapters/pi/extension.ts';
import type { ComputerUseSessionView } from '../../src/types/computerUseApi.ts';

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
  it('preserves unrelated tools and avoids redundant host updates', () => {
    let activeTools = ['read', 'computer_state'];
    const setActiveTools = vi.fn((next: string[]) => {
      activeTools = next;
    });
    const pi = { getActiveTools: () => activeTools, setActiveTools };

    reconcileTools(pi, false);
    expect(activeTools).toEqual(['read']);
    reconcileTools(pi, false);
    expect(setActiveTools).toHaveBeenCalledTimes(1);
    reconcileTools(pi, true);
    expect(activeTools).toEqual(['read', 'computer_state', 'computer_action']);
  });
});
