import { piMinorModes } from '@agimon-ai/doompi-minor-mode';
import { COMPUTER_USE_GUIDANCE } from '../constants/computerUse';
import { type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import { defineMinorMode, type MinorModeOwner, type MinorModeOwnerActionContext } from '@agimon-ai/doompi-minor-mode';
import { type DoomToolRestriction } from '@agimon-ai/doompi-core/tool-surface';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createComputerUseCommand } from './computerUseCommand';
import {
  COMPUTER_USE_MODE_ID,
  COMPUTER_USE_MODE_STATUS_KEY,
  COMPUTER_USE_STATUS_KEY,
  type ComputerUseSessionView,
} from '../types/computerUseApi';
import type { ComputerUseAction } from '../types/computerUse';
import type { ComputerUseExtensionDependencies } from '../types/extension';

const PACKAGE_SOURCE = '@agimon-ai/doompi-computer-use';
export { COMPUTER_USE_MODE_ID };
import { modeState, computerUseRestriction } from '../models/computerUseMode';

export function createComputerUseRuntime(
  dependencies: ComputerUseExtensionDependencies,
  signal: AbortSignal,
): PiPluginContributions<ComputerUseExtensionDependencies> & {
  tools: readonly Parameters<ExtensionAPI['registerTool']>[0][];
} {
  const client = dependencies.client;
  let state: ComputerUseSessionView | undefined;
  let enabled = false;
  let restriction: DoomToolRestriction = computerUseRestriction(false);
  const restrictionListeners = new Set<() => void>();
  const reconcileTools = (active: boolean): void => {
    restriction = computerUseRestriction(active);
    for (const listener of restrictionListeners) listener();
  };
  let globallyEnabled = false;
  let mode: MinorModeOwner<MinorModeOwnerActionContext<ExtensionContext>>;
  const modeListeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let publishedMode = '';
  let publishedModeStatus: string | undefined;
  let publishedActivityStatus: string | undefined;
  const publish = (): void => {
    const phase = state?.phase ?? 'inactive';
    const projection = `${enabled}:${phase}:${state?.revision ?? 'none'}`;
    if (mode !== undefined && projection !== publishedMode) {
      mode.publish();
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
    if (signal.aborted) return;
    let nextGloballyEnabled = false;
    try {
      nextGloballyEnabled = (await dependencies.enabled?.()) === true;
    } catch {
      nextGloballyEnabled = false;
    }
    if (signal.aborted) return;
    if (nextGloballyEnabled !== globallyEnabled) {
      globallyEnabled = nextGloballyEnabled;
      if (!globallyEnabled) {
        if (client !== undefined && state !== undefined && state.phase !== 'inactive' && state.phase !== 'failed') {
          try {
            await client.stop();
          } catch {
            // The global opt-in is still authoritative even when remote cleanup fails.
          }
        }
        enabled = false;
        state = undefined;
        reconcileTools(false);
      }
      publishedMode = '';
      for (const listener of modeListeners) listener();
    }
    if (!globallyEnabled || client === undefined) {
      state = undefined;
      reconcileTools(false);
      publish();
      return;
    }
    try {
      const nextState = await client.state(signal);
      if (signal.aborted) return;
      state = nextState;
      reconcileTools(state.phase === 'active');
      publish();
    } catch {
      state = undefined;
      reconcileTools(false);
      publish();
    }
  };
  mode = defineMinorMode<undefined, MinorModeOwnerActionContext<ExtensionContext>>({
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
    state: () => modeState(state, enabled),
    async handleAction(_runtime, actionId, _argumentsValue, execution) {
      activeContext = execution.context;
      if (actionId === 'activate') {
        if ((await dependencies.enabled?.()) !== true) {
          await refresh();
          throw new Error('Enable computer use in global settings first.');
        }
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
  }).createOwner(undefined);
  return {
    commands: [createComputerUseCommand(dependencies.service)],
    tools: [
      {
        name: 'computer_state',
        label: 'Computer State',
        description: 'Observe the authorized application window and return its semantic accessibility state.',
        promptSnippet: 'Observe the authorized application before choosing a semantic action',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_toolCallId, _params, signal) {
          if (!globallyEnabled || client === undefined || state?.phase !== 'active')
            throw new Error('Computer use is not active for this session.');
          const observation = await client.observe(signal);
          return { content: [{ type: 'text', text: JSON.stringify(observation, null, 2) }], details: observation };
        },
      },
      {
        name: 'computer_action',
        label: 'Computer Action',
        description: 'Perform one constrained semantic action in the authorized application window.',
        promptSnippet: 'Perform one action using a current computer_state snapshot and element ref',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['press', 'focus', 'set_value', 'scroll'] },
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
          if (!globallyEnabled || client === undefined || state?.phase !== 'active')
            throw new Error('Computer use is not active for this session.');
          const result = await client.act(params as unknown as ComputerUseAction, signal);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
        },
      },
      {
        name: 'computer_exec',
        label: 'Computer Script',
        description:
          'Run a trusted, explicitly allowed local TypeScript script against the authorized application session.',
        promptSnippet: 'Run a trusted reusable computer script by its explicitly allowed path and JSON input',
        parameters: {
          type: 'object',
          properties: {
            scriptPath: { type: 'string' },
            input: {},
          },
          required: ['scriptPath', 'input'],
          additionalProperties: false,
        },
        async execute(_toolCallId, params, signal) {
          if (!globallyEnabled || client === undefined || state?.phase !== 'active')
            throw new Error('Computer use is not active for this session.');
          if (dependencies.scriptRunner === undefined) throw new Error('Computer script execution is unavailable.');
          const input = params as { scriptPath: string; input: unknown };
          const result = await dependencies.scriptRunner.execute(input.scriptPath, input.input, signal);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
        },
      },
    ],
    services: [
      piMinorModes({
        snapshot: () => (globallyEnabled ? [mode] : []),
        subscribe(listener) {
          modeListeners.add(listener);
          return () => {
            modeListeners.delete(listener);
          };
        },
      }),
    ],
    toolRestrictions: [
      {
        source: PACKAGE_SOURCE,
        restrict: (incoming, available) => restriction(incoming, available),
        subscribe(listener) {
          restrictionListeners.add(listener);
          return () => {
            restrictionListeners.delete(listener);
          };
        },
      },
    ],
    events: {
      before_agent_start: (event) =>
        globallyEnabled && state?.phase === 'active'
          ? { systemPrompt: `${event.systemPrompt}\n\n${COMPUTER_USE_GUIDANCE}` }
          : undefined,
      session_start: (_event, context) => {
        if (signal.aborted) return;
        activeContext = context;
        reconcileTools(false);
        void refresh();
        if (timer) clearInterval(timer);
        timer = setInterval(() => void refresh(), 250);
        timer.unref?.();
      },
    },
    onStop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    onDispose() {
      if (timer) clearInterval(timer);
      timer = undefined;
      reconcileTools(false);
      activeContext?.ui.setStatus(COMPUTER_USE_MODE_STATUS_KEY, undefined);
      activeContext?.ui.setStatus(COMPUTER_USE_STATUS_KEY, undefined);
      activeContext = undefined;
    },
  };
}
