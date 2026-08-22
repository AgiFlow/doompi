import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import {
  DOOM_TRANSITION_SERVICE,
  type DoomTransitionCoordinator,
} from '@agimon-ai/doompi-extension-contracts/transition';
import { Context } from '@deepseek-ai/cordis';
import { createDoomTransitionCoordinator } from '../../src/services/transitionCoordinator.ts';
import type {
  TransitionSelectionSnapshot,
  TransitionSynchronization,
} from '@agimon-ai/doompi-extension-contracts/transition';

interface TestCoordinatorOptions {
  readonly current: TransitionSelectionSnapshot;
  readonly majorModesConfig?: MajorModesConfig;
  readonly hooksEnabled?: boolean;
  readonly synchronization?: TransitionSynchronization;
}

function defaultMajorModes(current: TransitionSelectionSnapshot): MajorModesConfig {
  return {
    defaultMajorMode: current.majorMode,
    layers: Object.fromEntries(current.layers.map((name) => [name, { baseDirectory: process.cwd() }])),
    majorMode: {
      [current.majorMode]: {
        description: 'Test major mode',
        layers: [...current.layers],
      },
    },
  };
}

export function bindTestTransitionCoordinator(
  context: Context,
  sessionId: string,
  options: TestCoordinatorOptions,
): { readonly coordinator: DoomTransitionCoordinator; dispose(): void } {
  const coordinator = createDoomTransitionCoordinator({
    sessionId,
    classifierContext: () => ({
      current: options.current,
      majorModesConfig: options.majorModesConfig ?? defaultMajorModes(options.current),
      hooksEnabled: options.hooksEnabled ?? true,
      synchronization: options.synchronization ?? { kind: 'launcher' },
    }),
  });
  const unpublish = context.provide(DOOM_TRANSITION_SERVICE, coordinator);
  return {
    coordinator,
    dispose() {
      unpublish();
      coordinator.dispose();
    },
  };
}
