import type {
  DoomHeadlessCommand,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_HELP_WHEN as HELP_WHEN } from '@agimon-ai/doompi-core/help';
import {
  type DoomServerSessionPlugin,
  packageResourcePath,
  readPackageResource,
} from '@agimon-ai/doompi-core/serverFacet';
import {
  defineMinorMode,
  serverMinorModes,
  type MinorModeOwner,
  type MinorModeState,
} from '@agimon-ai/doompi-minor-mode';

import {
  HELP_COMMAND_DESCRIPTION,
  HELP_COMMAND_NAME,
  HELP_GUIDANCE,
  HELP_MODE_ID,
  HELP_PACKAGE_SOURCE,
  HELP_SKILL,
} from '../../constants/help';
import { createHelpStatusTool, helpStatusDetail, serverHelpStatus } from '../helpStatus';
export function createHelpServerSession(host: DoomHeadlessHostService): DoomServerSessionPlugin {
  let modeOwner: MinorModeOwner | undefined;
  let pending: boolean | undefined;
  let failure: string | undefined;
  let generation = 0;
  let disposed = false;
  const active = () => (host.context.selection.state?.['minor-mode'] ?? []).includes(HELP_MODE_ID);
  const inspect = () => serverHelpStatus(host.inspectCapabilities(), active());
  const modeState = (): MinorModeState => {
    const report = inspect();
    return {
      activation: pending === true ? 'activating' : active() ? 'active' : 'inactive',
      condition:
        pending !== undefined || !report.ready
          ? 'queued'
          : failure
            ? 'failed'
            : report.activation === 'degraded'
              ? 'degraded'
              : 'ready',
      ...(pending !== undefined
        ? { detail: 'applying Help capabilities' }
        : failure
          ? { detail: failure }
          : active()
            ? { detail: helpStatusDetail(report) }
            : {}),
      actions: [
        {
          id: 'activate',
          enabled: !active() && pending === undefined,
          ...(!active() && pending === undefined ? {} : { disabledReason: 'Help is active or changing.' }),
        },
        {
          id: 'deactivate',
          enabled: active() || pending === true,
          ...(active() || pending === true ? {} : { disabledReason: 'Help mode is not active.' }),
        },
      ],
    };
  };
  const resources: DoomHeadlessResource[] = [
    { when: HELP_WHEN, name: 'doompi-help', kind: 'context', read: () => HELP_GUIDANCE },
    {
      when: HELP_WHEN,
      ...HELP_SKILL,
      kind: 'skill',
      path: packageResourcePath(import.meta.url, 'src/prompts/doompi-use-help/SKILL.md'),
      read: async () => {
        const text = await readPackageResource(import.meta.url, 'src/prompts/doompi-use-help/SKILL.md');
        if (!text.trim()) throw new Error('The installed Help skill is missing or unreadable.');
        return text;
      },
    },
  ];
  const selectMode = async (enabled: boolean, signal?: AbortSignal): Promise<void> => {
    if (disposed) throw new Error('Help runtime is disposed.');
    signal?.throwIfAborted();
    const operation = ++generation;
    pending = enabled;
    failure = undefined;
    modeOwner?.publish();
    try {
      if (enabled) await resources[1]!.read(host.context);
      signal?.throwIfAborted();
      if (operation !== generation || disposed) throw new Error('Help activation was cancelled.');
      const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== HELP_MODE_ID);
      await host.changeSelection({
        axis: 'state',
        key: 'minor-mode',
        values: enabled ? [...modes, HELP_MODE_ID] : modes,
      });
    } catch (error) {
      if (operation === generation) failure = (error instanceof Error ? error.message : String(error)).slice(0, 160);
      throw error;
    } finally {
      if (operation === generation) {
        pending = undefined;
        modeOwner?.publish();
      }
    }
  };
  const command: DoomHeadlessCommand = {
    name: HELP_COMMAND_NAME,
    description: HELP_COMMAND_DESCRIPTION,
    async execute(_args, execution) {
      await selectMode(!(pending ?? active()));
      await execution.client.notify({
        title: 'DoomPi Help',
        body: active() ? 'Help mode activated.' : 'Help mode deactivated.',
        level: 'info',
      });
    },
  };
  modeOwner = defineMinorMode({
    descriptor: {
      source: HELP_PACKAGE_SOURCE,
      id: HELP_MODE_ID,
      label: 'Help',
      description: 'Package guidance and read-only diagnostics for agent setup and debugging.',
      order: 50,
      actions: [
        {
          id: 'activate',
          label: 'Activate',
          description: 'Expose Help guidance and diagnostic tools.',
          contexts: ['headless'],
          parameters: [],
        },
        {
          id: 'deactivate',
          label: 'Deactivate',
          description: 'Withdraw Help-only guidance and diagnostic tools.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    state: modeState,
    async handleAction(_runtime, actionId, _argumentsValue, { signal }) {
      if (actionId !== 'activate' && actionId !== 'deactivate')
        throw new Error(`Unknown Help mode action: ${actionId}`);
      await selectMode(actionId === 'activate', signal);
      return { message: active() ? 'Help mode activated.' : 'Help mode deactivated.' };
    },
  }).createOwner(undefined);
  return {
    services: [serverMinorModes([modeOwner])],
    resources,
    commands: [command],
    tools: [
      createHelpStatusTool(inspect, (signal) => {
        signal?.throwIfAborted();
        host.assertActive(HELP_PACKAGE_SOURCE);
        if (disposed || !active()) throw new Error('Help mode is not active.');
        return signal ?? new AbortController().signal;
      }),
    ],
    onDispose() {
      disposed = true;
      generation += 1;
    },
  };
}
