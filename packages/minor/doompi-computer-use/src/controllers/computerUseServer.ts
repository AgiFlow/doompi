import { COMMAND_NAME, COMMAND_DESCRIPTION } from '../constants/computerUse';
import { type DoomHeadlessToolResult } from '@agimon-ai/doompi-extension-contracts/headless';
import { defineMinorMode, type MinorModeOwner } from '@agimon-ai/doompi-extension-contracts/mode';
import { COMPUTER_USE_MODE_ID } from '../types/computerUseApi';
import { COMPUTER_USE_TOOL_NAMES } from '../constants/computerUse';
import { modeState } from '../models/computerUseMode';
import path from 'node:path';
import { createComputerUseSessionClient } from '../services/sessionApiClient';
import { ComputerScriptRunner } from '../services/computerScriptRunner';
import { DefaultComputerUseExtensionService } from '../services/extensionService';
import type { ComputerUseAction, ComputerUseObservation } from '../types/computerUse';
import type { ComputerUseSessionView } from '../types/computerUseApi';

const SOURCE = '@agimon-ai/doompi-computer-use';

const SCRIPT_PATHS_ENV = 'DOOMPI_COMPUTER_USE_SCRIPT_PATHS';
const GUIDANCE =
  '[COMPUTER USE ACTIVE]\nUse computer_state before acting and after any action that may change the interface. Use only element refs and snapshot ids returned by computer_state. Never infer coordinates or bypass secure elements.';

function output(value: unknown, isError = false): DoomHeadlessToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  };
}

function observationOutput(value: ComputerUseObservation): DoomHeadlessToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ...value, screenshot: undefined }, null, 2) },
      { type: 'image', data: value.screenshot.data, mimeType: value.screenshot.mimeType },
    ],
    details: value,
  };
}

import {
  type DoomHeadlessHostService,
  type DoomHeadlessTool,
  type DoomHeadlessCommand,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { type DoomServerSessionPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
export function createComputerUseServer(host: DoomHeadlessHostService): Omit<
  DoomServerSessionPlugin,
  'tools' | 'commands'
> & {
  tools: readonly DoomHeadlessTool[];
  commands: readonly DoomHeadlessCommand[];
} {
  const client = createComputerUseSessionClient();
  const allowedScriptPaths = (host.context.environment[SCRIPT_PATHS_ENV] ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  const scriptRunner = client === undefined ? undefined : new ComputerScriptRunner({ client, allowedScriptPaths });
  const service = new DefaultComputerUseExtensionService(client);
  const dependencies = { client, scriptRunner, service };
  let state: ComputerUseSessionView | undefined;
  let stopActivity: (() => void) | undefined;
  let modeOwner: MinorModeOwner | undefined;
  const modeSelected = (): boolean => host.context.selection.minorModes.includes(COMPUTER_USE_MODE_ID);
  const publishMode = (): void => modeOwner?.publish();
  const applyState = (next: ComputerUseSessionView | undefined): void => {
    state = next;
    host.context.client.setStatus(
      SOURCE,
      next === undefined || next.phase === 'inactive' ? undefined : `computer use: ${next.phase}`,
    );
    publishMode();
  };
  const selectMode = async (enabled: boolean): Promise<void> => {
    const modes = host.context.selection.minorModes.filter((mode) => mode !== COMPUTER_USE_MODE_ID);
    await host.changeSelection({
      axis: 'minorModes',
      minorModes: enabled ? [...modes, COMPUTER_USE_MODE_ID] : modes,
    });
    publishMode();
  };
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    if (!client) {
      applyState(undefined);
      return;
    }
    try {
      applyState(await client.state(signal));
    } catch {
      applyState(undefined);
    }
  };
  const requireActive = (): NonNullable<typeof client> => {
    if (!client || state?.phase !== 'active') throw new Error('Computer use is not active for this session.');
    return client;
  };
  modeOwner = defineMinorMode<undefined>({
    descriptor: {
      source: SOURCE,
      id: COMPUTER_USE_MODE_ID,
      label: 'Computer Use',
      description: 'Session-scoped semantic control through DoomPi Desktop.',
      order: 450,
      actions: [
        {
          id: 'activate',
          label: 'Activate',
          description: 'Enable computer use for this session.',
          contexts: ['headless'],
          parameters: [],
        },
        {
          id: 'deactivate',
          label: 'Deactivate',
          description: 'Stop this session computer-use run.',
          contexts: ['headless'],
          parameters: [],
        },
        {
          id: 'doctor',
          label: 'Doctor',
          description: 'Report Desktop availability and session state.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    state: () => modeState(state, modeSelected()),
    async handleAction(_runtime, actionId, _argumentsValue, execution) {
      execution.signal.throwIfAborted();
      if (actionId === 'activate') {
        if (!client) throw new Error('DoomPi Desktop computer use is unavailable.');
        await selectMode(true);
        await refresh(execution.signal);
        return { message: 'Computer use activated.' };
      }
      if (actionId === 'doctor') {
        await refresh(execution.signal);
        return {
          message: client
            ? `Computer use is ${state?.phase ?? 'unavailable'}.`
            : 'DoomPi Desktop session API is unavailable.',
        };
      }
      if (actionId === 'deactivate') {
        if (client && state?.phase !== undefined && state.phase !== 'inactive' && state.phase !== 'failed')
          await client.stop(execution.signal);
        await selectMode(false);
        await refresh(execution.signal);
        return { message: 'Computer use deactivated.' };
      }
      throw new Error(`Unknown computer-use action: ${actionId}`);
    },
  }).createOwner(undefined);
  return {
    minorModes: [modeOwner],
    toolRestrictions: [
      {
        minorMode: COMPUTER_USE_MODE_ID,
        allowedTools: [...COMPUTER_USE_TOOL_NAMES],
      },
    ],
    activities: [
      {
        when: { minorMode: COMPUTER_USE_MODE_ID },
        name: SOURCE,
        async start() {
          await refresh();
          const unsubscribe = client?.subscribeStatus?.(applyState);
          stopActivity = () => {
            unsubscribe?.();
            applyState(undefined);
          };
          return () => {
            stopActivity?.();
            stopActivity = undefined;
          };
        },
      },
    ],
    tools: [
      {
        when: { minorMode: COMPUTER_USE_MODE_ID },
        name: 'computer_state',
        label: 'Computer State',
        description: 'Observe the authorized application window and return semantic accessibility state.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        executionMode: 'serial',
        async execute(_toolCallId, _parameters, signal) {
          try {
            const session = requireActive();
            const observation = await session.observe(signal);
            return observationOutput(observation);
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      },
      {
        when: { minorMode: COMPUTER_USE_MODE_ID },
        name: 'computer_action',
        label: 'Computer Action',
        description: 'Perform one constrained semantic action in the authorized application window.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['press', 'focus', 'set_value', 'scroll'] },
            snapshotId: { type: 'string', minLength: 1 },
            elementRef: { type: 'string', minLength: 1 },
            value: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'string', enum: ['line', 'page'] },
          },
          required: ['kind', 'snapshotId', 'elementRef'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          try {
            const result = await requireActive().act(parameters as unknown as ComputerUseAction, signal);
            await refresh(signal);
            return output(result);
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      },
      {
        when: { minorMode: COMPUTER_USE_MODE_ID },
        name: 'computer_exec',
        label: 'Computer Script',
        description:
          'Run a trusted, explicitly allowed local TypeScript script against the authorized application session.',
        parameters: {
          type: 'object',
          properties: { scriptPath: { type: 'string', minLength: 1 }, input: {} },
          required: ['scriptPath', 'input'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          try {
            if (!dependencies.scriptRunner) throw new Error('Computer script execution is unavailable.');
            const input = parameters as { scriptPath: string; input: unknown };
            return output(await dependencies.scriptRunner.execute(input.scriptPath, input.input, signal));
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      },
    ],
    commands: [
      {
        name: COMMAND_NAME,
        description: COMMAND_DESCRIPTION,
        async execute(args, execution) {
          const result = await dependencies.service.execute();
          await execution.client.notify({ body: result.message, level: result.level });
          if (args.trim() === 'deactivate' && client && state?.phase !== 'inactive' && state?.phase !== 'failed') {
            await client.stop();
            await host.changeSelection({
              axis: 'minorModes',
              minorModes: execution.selection.minorModes.filter((mode) => mode !== COMPUTER_USE_MODE_ID),
            });
            await refresh();
          }
        },
      },
    ],
    hooks: [
      {
        when: { minorMode: COMPUTER_USE_MODE_ID },
        event: 'before_agent_start',
        handle(event) {
          if (state?.phase !== 'active') return undefined;
          const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return { systemPrompt: `${prompt}\n\n${GUIDANCE}`.trim() };
        },
      },
      {
        when: { minorMode: COMPUTER_USE_MODE_ID },
        event: 'session_shutdown',
        handle: async () => {
          stopActivity?.();
          if (client && state?.phase !== 'inactive' && state?.phase !== 'failed') await client.stop();
        },
      },
    ],
    onDispose() {
      stopActivity?.();
      stopActivity = undefined;
      host.context.client.setStatus(SOURCE, undefined);
    },
  };
}
