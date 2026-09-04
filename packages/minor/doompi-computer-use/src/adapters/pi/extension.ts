import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeOwnerHandle,
  type MinorModeState,
  registerMinorModeOwner,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerComputerUseCommand } from '../../commands/computerUseCommand.ts';
import { createComputerUseContainer } from '../../container/index.ts';
import {
  COMPUTER_USE_MODE_ID,
  COMPUTER_USE_MODE_STATUS_KEY,
  COMPUTER_USE_STATUS_KEY,
  type ComputerUseSessionView,
} from '../../types/computerUseApi.ts';
import type { ComputerUseAction } from '../../types/computerUse.ts';
import type { ComputerUseExtensionDependencies } from '../../types/extension.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-computer-use';
export { COMPUTER_USE_MODE_ID };
export const COMPUTER_USE_TOOL_NAMES = ['computer_state', 'computer_action'] as const;
export const COMPUTER_USE_GUIDANCE = `[COMPUTER USE ACTIVE]
Use computer_state before acting and after any action that may change the interface. Use only element refs and snapshot ids returned by computer_state. Use computer_action for one semantic press, set_value, or scroll at a time. Never infer coordinates, inspect another application, bypass secure elements, or retry an uncertain outcome. Stop computer use when the task is complete.`;

export function modeState(state?: ComputerUseSessionView, enabled = false): MinorModeState {
  const phase = state?.phase ?? 'inactive';
  const running = phase !== 'inactive' && phase !== 'failed';
  const modeEnabled = enabled || running;
  const activation = modeEnabled
    ? phase === 'stopping'
      ? 'deactivating'
      : phase === 'awaiting_confirmation' || phase === 'activating'
        ? 'activating'
        : 'active'
    : 'inactive';
  return {
    activation,
    condition:
      phase === 'awaiting_confirmation'
        ? 'blocked'
        : phase === 'failed'
          ? 'failed'
          : phase === 'activating' || phase === 'stopping'
            ? 'queued'
            : 'ready',
    ...(modeEnabled && phase === 'inactive' ? { detail: 'configure computer use in Activity' } : {}),
    ...(phase === 'awaiting_confirmation' ? { detail: 'awaiting confirmation in Activity' } : {}),
    actions: [
      {
        id: 'activate',
        enabled: !modeEnabled,
        ...(!modeEnabled ? {} : { disabledReason: 'Computer use is already enabled.' }),
      },
      {
        id: 'deactivate',
        enabled: modeEnabled,
        ...(modeEnabled ? {} : { disabledReason: 'Computer use is not enabled.' }),
      },
      { id: 'doctor', enabled: true },
    ],
  };
}

export function reconcileTools(pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>, active: boolean): void {
  const owned = new Set<string>(COMPUTER_USE_TOOL_NAMES);
  const current = pi.getActiveTools();
  const next = current.filter((name) => !owned.has(name));
  if (active) next.push(...COMPUTER_USE_TOOL_NAMES);
  if (next.length !== current.length || next.some((name, index) => name !== current[index])) pi.setActiveTools(next);
}

export function installComputerUseRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  dependencies: ComputerUseExtensionDependencies = createComputerUseContainer(),
): void {
  const client = dependencies.client;
  let state: ComputerUseSessionView | undefined;
  let enabled = false;
  let mode: MinorModeOwnerHandle | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let publishedMode = '';
  let publishedModeStatus: string | undefined;
  let publishedActivityStatus: string | undefined;

  const publish = (): void => {
    const phase = state?.phase ?? 'inactive';
    const projection = `${enabled}:${phase}:${state?.revision ?? 'none'}`;
    if (mode !== undefined && projection !== publishedMode) {
      mode.publish(modeState(state, enabled));
      publishedMode = projection;
    }
    const modeStatus = state === undefined ? undefined : enabled || phase !== 'inactive' ? phase : '';
    if (activeContext !== undefined && modeStatus !== publishedModeStatus) {
      activeContext.ui.setStatus(COMPUTER_USE_MODE_STATUS_KEY, modeStatus);
      publishedModeStatus = modeStatus;
    }
    const activityStatus = enabled || phase !== 'inactive' ? `computer use: ${phase}` : undefined;
    if (activeContext !== undefined && activityStatus !== publishedActivityStatus) {
      activeContext.ui.setStatus(COMPUTER_USE_STATUS_KEY, activityStatus);
      publishedActivityStatus = activityStatus;
    }
  };
  const refresh = async (): Promise<void> => {
    if (client === undefined) {
      state = undefined;
      reconcileTools(pi, false);
      publish();
      return;
    }
    try {
      state = await client.state();
      reconcileTools(pi, state.phase === 'active');
      publish();
    } catch {
      state = undefined;
      reconcileTools(pi, false);
      publish();
    }
  };

  pi.registerTool({
    name: 'computer_state',
    label: 'Computer State',
    description: 'Observe the authorized application window and return its semantic accessibility state.',
    promptSnippet: 'Observe the authorized application before choosing a semantic action',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, signal) {
      if (client === undefined || state?.phase !== 'active')
        throw new Error('Computer use is not active for this session.');
      const observation = await client.observe(signal);
      return { content: [{ type: 'text', text: JSON.stringify(observation, null, 2) }], details: observation };
    },
  });
  pi.registerTool({
    name: 'computer_action',
    label: 'Computer Action',
    description: 'Perform one constrained semantic action in the authorized application window.',
    promptSnippet: 'Perform one action using a current computer_state snapshot and element ref',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['press', 'set_value', 'scroll'] },
        snapshotId: { type: 'string' },
        elementRef: { type: 'string' },
        value: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'string', enum: ['line', 'page'] },
      },
      required: ['kind', 'snapshotId', 'elementRef'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      if (client === undefined || state?.phase !== 'active')
        throw new Error('Computer use is not active for this session.');
      const result = await client.act(params as unknown as ComputerUseAction, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (context) => {
    const owner = registerMinorModeOwner<ExtensionContext>(requireMinorModeCatalog(context), {
      descriptor: {
        source: PACKAGE_SOURCE,
        id: COMPUTER_USE_MODE_ID,
        label: 'Computer Use',
        description: 'Session-scoped semantic control through DoomPi Desktop.',
        order: 450,
        actions: [
          {
            id: 'activate',
            label: 'Activate',
            description: 'Open the cockpit activation workflow and native confirmation.',
            contexts: ['tui', 'headless'],
            parameters: [],
          },
          {
            id: 'deactivate',
            label: 'Deactivate',
            description: 'Stop this session computer-use run.',
            contexts: ['tui', 'headless'],
            parameters: [],
          },
          {
            id: 'doctor',
            label: 'Doctor',
            description: 'Report Desktop availability and session state.',
            contexts: ['tui', 'headless'],
            parameters: [],
          },
        ],
      },
      initialState: modeState(state, enabled),
      async handleAction(actionId, _argumentsValue, execution) {
        activeContext = execution.context;
        if (actionId === 'activate') {
          if (client === undefined) throw new Error('DoomPi Desktop computer use is unavailable.');
          enabled = true;
          await refresh();
          publish();
          return { message: 'Computer use is ready to configure in Activity.' };
        }
        if (actionId === 'doctor') {
          await refresh();
          return {
            message:
              client === undefined
                ? 'DoomPi Desktop session API is unavailable.'
                : `Computer use is ${state?.phase.replaceAll('_', ' ') ?? 'unavailable'}.`,
          };
        }
        if (actionId === 'deactivate') {
          if (client === undefined) throw new Error('DoomPi Desktop computer use is unavailable.');
          if (state !== undefined && state.phase !== 'inactive' && state.phase !== 'failed')
            await client.stop(execution.signal);
          enabled = false;
          await refresh();
          publish();
          return { message: 'Computer use is off.' };
        }
        throw new Error(`Unknown computer-use action: ${actionId}`);
      },
    });
    mode = owner;
    return () => {
      owner.dispose();
      if (mode === owner) mode = undefined;
    };
  });

  pi.on('before_agent_start', (event) =>
    state?.phase === 'active' ? { systemPrompt: `${event.systemPrompt}\n\n${COMPUTER_USE_GUIDANCE}` } : undefined,
  );
  pi.on('session_start', (_event, context) => {
    activeContext = context;
    reconcileTools(pi, false);
    void refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(() => void refresh(), 250);
    timer.unref?.();
  });
  cordis.effect(
    () => () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      reconcileTools(pi, false);
      activeContext?.ui.setStatus(COMPUTER_USE_MODE_STATUS_KEY, undefined);
      activeContext?.ui.setStatus(COMPUTER_USE_STATUS_KEY, undefined);
      activeContext = undefined;
      mode?.dispose();
      mode = undefined;
    },
    `${PACKAGE_SOURCE}/runtime`,
  );

  registerComputerUseCommand(pi, dependencies.service);
}

interface ComputerUsePluginConfig {
  readonly pi: ExtensionAPI;
  readonly dependencies: ComputerUseExtensionDependencies;
}

function computerUsePlugin(cordis: Context, config: ComputerUsePluginConfig): void {
  installComputerUseRuntime(cordis, config.pi, config.dependencies);
}

export async function activateComputerUseExtension(
  pi: ExtensionAPI,
  dependencies: ComputerUseExtensionDependencies = createComputerUseContainer(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE, { allowStandalone: true });
  const fiber = connection.root.plugin(computerUsePlugin, { pi, dependencies });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default activateComputerUseExtension;
