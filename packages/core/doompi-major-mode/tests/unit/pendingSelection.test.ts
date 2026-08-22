import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { DoomConfigContext, DoomConfigPendingSelection } from '@agimon-ai/doompi-config/types';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import type { TransitionSelectionSnapshot } from '@agimon-ai/doompi-extension-contracts/transition';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindPendingSelection,
  clearPendingSelection,
  selectionFromSnapshot,
} from '../../src/services/pendingSelection.ts';

let cordis: Context | undefined;

function pending(): DoomConfigPendingSelection {
  return {
    version: 1,
    operationId: 'op-1',
    active: { version: 1, majorMode: 'copilot', domains: ['default'] },
    target: { version: 1, majorMode: 'minimal', domains: ['default'] },
    strategy: 'process-relaunch',
    phase: 'pending',
  };
}

function session(pendingSelection?: DoomConfigPendingSelection) {
  const appendEntry = vi.fn();
  const pi = { appendEntry } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => 'pending-session' } } as unknown as ExtensionContext;
  cordis = new Context();
  provideDoomConfigContext(cordis, {
    settings: { projectTrust: 'ask' },
    harness: readHarnessState({}),
    pendingSelection,
    requiresRelaunch: pendingSelection !== undefined,
  });
  return { pi, ctx, cordis, appendEntry };
}

afterEach(() => {
  void cordis?.fiber.dispose();
  cordis = undefined;
});

describe('pending selection journal', () => {
  it('projects a transition snapshot into the journalled selection shape', () => {
    const snapshot: TransitionSelectionSnapshot = {
      domains: ['default', 'qa'],
      majorMode: 'copilot',
      layers: ['team'],
      profile: 'reviewer',
      compositionFingerprint: 'a'.repeat(64),
    };

    expect(selectionFromSnapshot(snapshot)).toEqual({
      version: 1,
      majorMode: 'copilot',
      domains: ['default', 'qa'],
      profile: 'reviewer',
      compositionFingerprint: 'a'.repeat(64),
    });
    // A copy: mutating the journal entry must not reach the plan.
    expect(selectionFromSnapshot(snapshot).domains).not.toBe(snapshot.domains);
  });

  it('supersedes an existing pending selection and clears it from the context', () => {
    const { pi, cordis, appendEntry } = session(pending());

    clearPendingSelection(pi, cordis);

    expect(appendEntry).toHaveBeenCalledWith('doom-pi:transition:v1', expect.objectContaining({ phase: 'superseded' }));
  });

  it('does nothing when no selection is pending', () => {
    const { pi, cordis, appendEntry } = session(undefined);

    clearPendingSelection(pi, cordis);

    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('freezes the bound selection so a later handler cannot mutate it', () => {
    const context = {
      settings: { projectTrust: 'ask' },
      harness: readHarnessState({}),
      requiresRelaunch: false,
    } as unknown as DoomConfigContext;

    const bound = bindPendingSelection(context, pending());

    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.pendingSelection)).toBe(true);
    expect(Object.isFrozen(bound.pendingSelection?.active.domains)).toBe(true);
    expect(bound.pendingSelection?.target.majorMode).toBe('minimal');
  });
});
