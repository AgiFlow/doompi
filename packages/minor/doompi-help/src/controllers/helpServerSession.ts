import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { readHelpResource } from '../services/helpResources';
import { type DoomHeadlessCommand, type DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';
import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-minor-mode';

const HELP_MODE_ID = 'help';

import { type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';
export function createHelpServerSession(host: DoomHeadlessHostService): DoomServerSessionPlugin {
  let modeOwner: MinorModeOwner | undefined;
  const modeState = (): MinorModeState => {
    const active = (host.context.selection.state?.['minor-mode'] ?? []).includes(HELP_MODE_ID);
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
    const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== HELP_MODE_ID);
    await host.changeSelection({
      axis: 'state',
      key: 'minor-mode',
      values: enabled ? [...modes, HELP_MODE_ID] : modes,
    });
    modeOwner?.publish();
  };
  const resources: DoomHeadlessResource[] = [
    {
      when: { state: { 'minor-mode': HELP_MODE_ID }, attribution: { kind: 'minor', mode: HELP_MODE_ID } },
      name: 'doompi-help',
      kind: 'context',
      read: () => readHelpResource('llms.txt'),
    },
    {
      when: { state: { 'minor-mode': HELP_MODE_ID }, attribution: { kind: 'minor', mode: HELP_MODE_ID } },
      name: 'doompi-use-help',
      kind: 'skill',
      read: () => readHelpResource('src/prompts/doompi-use-help/SKILL.md'),
    },
  ];
  const command: DoomHeadlessCommand = {
    name: 'doom-help',
    description: 'Show DoomPi help resources available in this session.',
    async execute(_args, execution) {
      await execution.client.notify({ title: 'DoomPi help', body: await readHelpResource('llms.txt'), level: 'info' });
    },
  };
  modeOwner = defineMinorMode({
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
    state: () => modeState(),
    async handleAction(_runtime, actionId, _argumentsValue, { signal }) {
      signal.throwIfAborted();
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
  }).createOwner(undefined);
  return {
    services: [serverMinorModes([modeOwner])],
    resources,
    commands: [command],
  };
}
