import { filterHookDisabledLayers, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { DOOM_TRANSITION_SERVICE, type DoomTransitionCoordinator } from '@agimon-ai/doompi-core/transition';
import type { TransitionSelectionSnapshot, TransitionSynchronization } from '@agimon-ai/doompi-core/transition';
import { createDoomTransitionCoordinator } from '@agimon-ai/doompi-core/transition-coordinator';
import { Context } from '@deepseek-ai/cordis';

import { extensionLayers } from '../../src/composition/transitionLayers';

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
  const config = options.majorModesConfig ?? defaultMajorModes(options.current);
  const coordinator = createDoomTransitionCoordinator({
    sessionId,
    classifierContext: () => ({
      current: options.current,
      resolveLayers: (majorMode) =>
        filterHookDisabledLayers(config, resolveLayers(config, majorMode), options.hooksEnabled ?? true),
      extensionLayers: (layers) => extensionLayers(config, layers),
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
