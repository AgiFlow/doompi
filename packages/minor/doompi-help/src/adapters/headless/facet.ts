import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import type { MinorModeState } from '@agimon-ai/doompi-extension-contracts/mode';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function readResource(file: string): Promise<string> {
  try {
    return await readFile(new URL(file, PACKAGE_ROOT), 'utf8');
  } catch {
    return '(resource unavailable)';
  }
}

const HELP_MODE_ID = 'help';

export const helpHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    let modeOwner: { publish(state: MinorModeState): void; dispose(): void } | undefined;
    const modeState = (): MinorModeState => {
      const active = host.context.selection.minorModes.includes(HELP_MODE_ID);
      return {
        activation: active ? 'active' : 'inactive',
        condition: 'ready',
        ...(active ? { detail: 'package help resources available' } : {}),
        actions: [
          {
            id: 'activate',
            enabled: !active,
            ...(!active ? {} : { disabledReason: 'Help mode is already active.' }),
          },
          {
            id: 'deactivate',
            enabled: active,
            ...(active ? {} : { disabledReason: 'Help mode is not active.' }),
          },
        ],
      };
    };
    const selectMode = async (enabled: boolean): Promise<void> => {
      const modes = host.context.selection.minorModes.filter((mode) => mode !== HELP_MODE_ID);
      await host.select({ minorModes: enabled ? [...modes, HELP_MODE_ID] : modes });
      modeOwner?.publish(modeState());
    };
    modeOwner = host.registerMinorMode({
      descriptor: {
        source: '@agimon-ai/doompi-help',
        id: HELP_MODE_ID,
        label: 'Help',
        description: 'Activation-gated package guidance from the installed Help resources.',
        order: 50,
        actions: [
          {
            id: 'activate',
            label: 'Activate',
            description: 'Expose package Help resources to the session.',
            contexts: ['headless'],
            parameters: [],
          },
          {
            id: 'deactivate',
            label: 'Deactivate',
            description: 'Hide package Help resources from the session.',
            contexts: ['headless'],
            parameters: [],
          },
        ],
      },
      initialState: modeState(),
      async handleAction(actionId, _argumentsValue, execution) {
        execution.signal.throwIfAborted();
        if (actionId === 'activate') {
          await selectMode(true);
          return { message: 'Help mode activated.' };
        }
        if (actionId === 'deactivate') {
          await selectMode(false);
          return { message: 'Help mode deactivated.' };
        }
        throw new Error(`Unknown Help mode action: ${actionId}`);
      },
    });
    const resources: DoomHeadlessResource[] = [
      { when: { minorMode: HELP_MODE_ID }, name: 'doompi-help', kind: 'context', read: () => readResource('llms.txt') },
      {
        when: { minorMode: HELP_MODE_ID },
        name: 'doompi-use-help',
        kind: 'skill',
        read: () => readResource('src/prompts/doompi-use-help/SKILL.md'),
      },
    ];
    const command: DoomHeadlessCommand = {
      name: 'doom-help',
      description: 'Show DoomPi help resources available in this session.',
      async execute(_args, execution) {
        await execution.client.notify({ title: 'DoomPi help', body: await readResource('llms.txt'), level: 'info' });
      },
    };
    const registrations = [
      ...resources.map((resource) => host.registerResource(resource)),
      host.registerCommand(command),
    ];
    return () => {
      modeOwner?.dispose();
      for (const registration of registrations) registration.dispose();
    };
  },
};
