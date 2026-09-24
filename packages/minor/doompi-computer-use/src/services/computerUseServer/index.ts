import path from 'node:path';

import { type DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import type { DoomApiContext } from '@agimon-ai/doompi-core/packageApi';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { defineMinorMode, type MinorModeOwner } from '@agimon-ai/doompi-minor-mode';

import { COMMAND_NAME, COMMAND_DESCRIPTION } from '../../constants/computerUse';
import { modeState } from '../../models/computerUseMode';
import { ComputerScriptRunner } from '../../services/computerScriptRunner';
import { DefaultComputerUseExtensionService } from '../../services/extensionService';
import type { ComputerScriptExecutionOptions } from '../../types/computerScript';
import type { ComputerUseAction } from '../../types/computerUse';
import { API_BASE_PATH, COMPUTER_USE_MODE_ID, COMPUTER_USE_STATUS_KEY } from '../../types/computerUseApi';
import type { ComputerUseSessionView } from '../../types/computerUseApi';
import {
  computerObservationOutput as observationOutput,
  computerScriptOutput,
  computerScriptFailure,
} from '../computerToolOutput';
import { createComputerUseApi } from '../computerUseApi';

/** This package's identity for mode, activity and restriction ownership, not a status key. */
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

import {
  type DoomHeadlessHostService,
  type DoomHeadlessTool,
  type DoomHeadlessCommand,
} from '@agimon-ai/doompi-core/headless';
import { type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';
export function createComputerUseServer(
  host: DoomHeadlessHostService,
  apiContext?: DoomApiContext,
): Omit<DoomServerSessionPlugin, 'tools' | 'commands'> & {
  tools: readonly DoomHeadlessTool[];
  commands: readonly DoomHeadlessCommand[];
} {
  if (!apiContext?.computerUse?.available || !apiContext.directEvents) return { tools: [], commands: [] };
  const desktop = apiContext.computerUse;
  const broker = createComputerUseApi({
    sessionId: host.context.sessionId,
    internalToken: apiContext.internalToken,
    hubToken: apiContext.hubToken,
    directEvents: apiContext.directEvents,
    desktop,
    beforeActivate: async () => {
      if (!modeSelected()) throw new Error('Enable computer use before authorizing an application.');
      const activity = await host.context.session.activity();
      if (!activity.isIdle || activity.hasPendingMessages)
        throw new Error('Wait for the agent and its queued prompts to finish before granting computer use.');
    },
  });
  const client = broker.sessionClient();
  const allowedScriptPaths = (host.context.environment[SCRIPT_PATHS_ENV] ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  const scriptRunner = new ComputerScriptRunner({ client, allowedScriptPaths, scriptRoot: host.context.cwd });
  const service = new DefaultComputerUseExtensionService(client);
  const dependencies = { client, scriptRunner, service };
  let state: ComputerUseSessionView | undefined = broker.state();
  const restrictionListeners = new Set<() => void>();
  let stopActivity: (() => void) | undefined;
  let modeOwner: MinorModeOwner | undefined;
  const modeSelected = (): boolean =>
    (host.context.selection.state?.['minor-mode'] ?? []).includes(COMPUTER_USE_MODE_ID);
  const publishMode = (): void => modeOwner?.publish();
  const applyState = (next: ComputerUseSessionView | undefined): void => {
    state = next;
    host.context.client.setStatus(
      COMPUTER_USE_STATUS_KEY,
      next === undefined || next.phase === 'inactive' ? undefined : `computer use: ${next.phase}`,
    );
    publishMode();
    for (const listener of restrictionListeners) listener();
  };
  const selectMode = async (enabled: boolean): Promise<void> => {
    const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== COMPUTER_USE_MODE_ID);
    await host.changeSelection({
      axis: 'state',
      key: 'minor-mode',
      values: enabled ? [...modes, COMPUTER_USE_MODE_ID] : modes,
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
    if (!desktop.available || desktop.enabled === false || !modeSelected() || state?.phase !== 'active')
      throw new Error('Computer use is not active for this session.');
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
    state: () => {
      const mode = modeState(state, modeSelected());
      return desktop.enabled === false
        ? {
            ...mode,
            condition: 'blocked',
            detail: 'Enable computer use in global Desktop settings.',
            actions: mode.actions.map((action) => ({
              ...action,
              enabled: false,
              disabledReason: 'Enable computer use in global Desktop settings.',
            })),
          }
        : mode;
    },
    async handleAction(_runtime, actionId, _argumentsValue, execution) {
      execution.signal.throwIfAborted();
      if (actionId === 'activate') {
        if (!desktop.available || desktop.enabled === false)
          throw new Error('Enable computer use in global Desktop settings first.');
        await selectMode(true);
        await refresh(execution.signal);
        return { message: 'Computer use is ready to configure in Activity.' };
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
  const unsubscribeState = client.subscribeStatus?.(applyState);
  return {
    api: [{ basePath: API_BASE_PATH, start: () => broker }],
    services: [
      (context) => {
        const fiber = context.plugin(serverMinorModes([modeOwner!]));
        context.effect(() =>
          desktop.subscribe(() => {
            if (!desktop.available) void fiber.dispose();
          }),
        );
      },
    ],
    toolRestrictions: [
      {
        source: SOURCE,
        restrict: () => ({
          excludedTools:
            desktop.available && desktop.enabled !== false && modeSelected() && state?.phase === 'active'
              ? []
              : ['computer_state', 'computer_action', 'computer_exec'],
        }),
        subscribe: (listener) => {
          restrictionListeners.add(listener);
          return () => {
            restrictionListeners.delete(listener);
          };
        },
      },
    ],
    activities: [
      {
        when: {
          state: { 'minor-mode': COMPUTER_USE_MODE_ID },
          attribution: { kind: 'minor', mode: COMPUTER_USE_MODE_ID },
        },
        name: SOURCE,
        async start() {
          await refresh();
          stopActivity = () => {
            void client.stop();
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
        when: {
          state: { 'minor-mode': COMPUTER_USE_MODE_ID },
          attribution: { kind: 'minor', mode: COMPUTER_USE_MODE_ID },
        },
        name: 'computer_state',
        label: 'Computer State',
        description: 'Observe the authorized application window and return semantic accessibility state.',
        parameters: {
          type: 'object',
          properties: { includeScreenshot: { type: 'boolean' } },
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, _parameters, signal) {
          try {
            const session = requireActive();
            const observation = await session.observe(signal, {
              includeScreenshot: (_parameters as { includeScreenshot?: boolean }).includeScreenshot !== false,
            });
            return observationOutput(observation);
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      },
      {
        when: {
          state: { 'minor-mode': COMPUTER_USE_MODE_ID },
          attribution: { kind: 'minor', mode: COMPUTER_USE_MODE_ID },
        },
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
        when: {
          state: { 'minor-mode': COMPUTER_USE_MODE_ID },
          attribution: { kind: 'minor', mode: COMPUTER_USE_MODE_ID },
        },
        name: 'computer_exec',
        label: 'Computer Script',
        description:
          'Run a reusable function with only the authorized program API. Relative helpers are supported. Full Node requires trusted:true and an explicitly allowlisted path.',
        parameters: {
          type: 'object',
          properties: {
            scriptPath: { type: 'string', minLength: 1 },
            input: {},
            trusted: { type: 'boolean' },
            includeScreenshot: { type: 'boolean' },
          },
          required: ['scriptPath', 'input'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          try {
            requireActive();
            if (!dependencies.scriptRunner) throw new Error('Computer script execution is unavailable.');
            const input = parameters as { scriptPath: string; input: unknown } & ComputerScriptExecutionOptions;
            return computerScriptOutput(
              await dependencies.scriptRunner.execute(input.scriptPath, input.input, signal, input),
            );
          } catch (error) {
            return computerScriptFailure(error);
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
              axis: 'state',
              key: 'minor-mode',
              values: (execution.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== COMPUTER_USE_MODE_ID),
            });
            await refresh();
          }
        },
      },
    ],
    hooks: [
      {
        when: {
          state: { 'minor-mode': COMPUTER_USE_MODE_ID },
          attribution: { kind: 'minor', mode: COMPUTER_USE_MODE_ID },
        },
        event: 'before_agent_start',
        handle(event) {
          if (state?.phase !== 'active') return undefined;
          const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return { systemPrompt: `${prompt}\n\n${GUIDANCE}`.trim() };
        },
      },
      {
        when: {
          state: { 'minor-mode': COMPUTER_USE_MODE_ID },
          attribution: { kind: 'minor', mode: COMPUTER_USE_MODE_ID },
        },
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
      unsubscribeState?.();
      broker.close();
      restrictionListeners.clear();
      host.context.client.setStatus(COMPUTER_USE_STATUS_KEY, undefined);
    },
  };
}
