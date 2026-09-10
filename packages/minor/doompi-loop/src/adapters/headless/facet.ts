import { DOOM_HEADLESS_HOST_SERVICE, requireDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import type { MinorModeOwnerHandle, MinorModeState } from '@agimon-ai/doompi-extension-contracts/mode';
import type { Context } from '@deepseek-ai/cordis';
import { createDoomLoopLaunchersService, type LoopLaunchersDependencies } from '../../services/loopLaunchers.ts';
import type {
  DoomLoopLaunchersService,
  LoopLauncherRegistration,
  StoppableLoop,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import { LIST_COMMAND_NAME, START_COMMAND_NAME } from '../../schemas/loopCommands.ts';
import { readFile } from 'node:fs/promises';

type HeadlessFacet = {
  inject: readonly string[];
  apply(context: Context): void | (() => void);
};

const SOURCE = '@agimon-ai/doompi-loop';
const MODE_ID = 'loop.active';
const DEFAULT_LAUNCHER_ID = 'doompi.default';
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 3600;

function notify(
  context: {
    client: { notify(request: { body: string; level?: 'info' | 'warning' | 'error' }): void | Promise<void> };
  },
  body: string,
  level: 'info' | 'warning' | 'error' = 'info',
): Promise<void> {
  return Promise.resolve(context.client.notify({ body, level }));
}

async function resource(): Promise<string> {
  return readFile(new URL('../../prompts/doompi-use-loop/SKILL.md', import.meta.url), 'utf8');
}

function numberInput(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_SECONDS || parsed > MAX_INTERVAL_SECONDS) {
    throw new Error(`Interval must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`);
  }
  return parsed;
}

export const loopHeadlessFacet: HeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    let launchers: DoomLoopLaunchersService | undefined;
    let defaultRegistration: LoopLauncherRegistration | undefined;
    let unsubscribe: (() => void) | undefined;
    let modeOwner: MinorModeOwnerHandle | undefined;
    const modeSelected = (): boolean => host.context.selection.minorModes.includes(MODE_ID);
    const modeState = (): MinorModeState => {
      const launcherCount = launchers?.listLaunchers().length ?? 0;
      const active = (launchers?.listInstances().length ?? 0) > 0;
      const canStart = launcherCount > 0 || !modeSelected();
      return {
        activation: active ? 'active' : 'inactive',
        condition: launchers?.listInstances().some(({ state }) => state !== 'running') ? 'queued' : 'ready',
        ...(active ? { detail: `${launchers?.listInstances().length} active`, color: 'warning' } : {}),
        actions: [
          {
            id: 'start',
            enabled: canStart,
            ...(canStart ? {} : { disabledReason: 'No loop launchers are registered.' }),
          },
          {
            id: 'stop',
            enabled: active,
            ...(active ? {} : { disabledReason: 'No loops are active.' }),
          },
        ],
      };
    };
    const publishMode = (): void => modeOwner?.publish(modeState());

    const startActivity = async (execution: typeof host.context): Promise<() => Promise<void>> => {
      if (launchers !== undefined) return async () => undefined;
      const dependencies: LoopLaunchersDependencies = {
        generation: `${execution.sessionId}:loop-launchers`,
        createInstanceId: () => crypto.randomUUID(),
        timestamp: () => new Date().toISOString(),
      };
      const service = createDoomLoopLaunchersService(dependencies);
      const registration = service.register({
        id: DEFAULT_LAUNCHER_ID,
        source: SOURCE,
        label: 'Default loop',
        description: 'Run a prompt in this session on an interval.',
        async launch({ instanceId, signal }): Promise<StoppableLoop | undefined> {
          const promptValue = await execution.client.request(
            { kind: 'input', title: 'Loop prompt', multiline: true },
            signal,
          );
          const prompt = typeof promptValue === 'string' ? promptValue.trim() : '';
          if (!prompt || signal.aborted) return undefined;
          const interval = numberInput(
            await execution.client.request(
              { kind: 'input', title: 'Loop interval in seconds', initialValue: String(DEFAULT_INTERVAL_SECONDS) },
              signal,
            ),
            DEFAULT_INTERVAL_SECONDS,
          );
          let stopped = false;
          const tick = (): void => {
            if (stopped || signal.aborted) return;
            void execution.session.prompt(prompt).catch((error) => {
              void notify(
                execution,
                `Loop pass failed: ${error instanceof Error ? error.message : String(error)}`,
                'warning',
              );
            });
          };
          const timer = setInterval(tick, interval * 1000);
          timer.unref?.();
          tick();
          return {
            instanceId,
            label: 'Default loop',
            detail: `every ${interval}s`,
            stop() {
              stopped = true;
              clearInterval(timer);
            },
          };
        },
      });
      launchers = service;
      defaultRegistration = registration;
      unsubscribe = service.subscribe(publishMode);
      publishMode();
      return async () => {
        unsubscribe?.();
        unsubscribe = undefined;
        await registration.dispose('Headless loop activity stopped.');
        await service.dispose('Headless loop activity stopped.');
        if (launchers === service) launchers = undefined;
        if (defaultRegistration === registration) defaultRegistration = undefined;
        publishMode();
      };
    };

    modeOwner = host.registerMinorMode({
      descriptor: {
        source: SOURCE,
        id: MODE_ID,
        label: 'Loop',
        description: 'Session-scoped recurring prompt loops.',
        order: 60,
        actions: [
          {
            id: 'start',
            label: 'Start',
            description: 'Start a loop with a registered launcher.',
            contexts: ['headless'],
            parameters: [
              { name: 'launcherId', label: 'Launcher', kind: 'string', required: true, minLength: 1 },
              { name: 'instanceId', label: 'Instance ID', kind: 'string', required: false, minLength: 1 },
            ],
          },
          {
            id: 'stop',
            label: 'Stop',
            description: 'Stop one active loop instance.',
            contexts: ['headless'],
            parameters: [
              { name: 'instanceId', label: 'Instance ID', kind: 'string', required: true, minLength: 1 },
              { name: 'reason', label: 'Reason', kind: 'string', required: false, minLength: 1 },
            ],
          },
        ],
      },
      initialState: modeState(),
      async handleAction(actionId, argumentsValue, execution) {
        execution.signal.throwIfAborted();
        if (actionId === 'start' && !launchers) {
          const modes = host.context.selection.minorModes.filter((mode) => mode !== MODE_ID);
          await host.select({ minorModes: [...modes, MODE_ID] });
        }
        if (!launchers) throw new Error('Loop activity is not active.');
        if (actionId === 'start') {
          const instance = await launchers.launch(
            String(argumentsValue.launcherId ?? ''),
            argumentsValue.instanceId ? { instanceId: String(argumentsValue.instanceId) } : {},
          );
          publishMode();
          return { message: instance ? `Loop '${instance.instanceId}' started.` : 'Loop launch was cancelled.' };
        }
        if (actionId === 'stop') {
          const stopped = await launchers.stop(
            String(argumentsValue.instanceId ?? ''),
            String(argumentsValue.reason ?? 'Stopped through minor_mode.'),
          );
          if (stopped && launchers.listInstances().length === 0) {
            const modes = host.context.selection.minorModes.filter((mode) => mode !== MODE_ID);
            await host.select({ minorModes: modes });
          }
          publishMode();
          return { message: stopped ? 'Loop stopped.' : 'Loop instance was not active.' };
        }
        throw new Error(`Unknown loop mode action: ${actionId}`);
      },
    });

    const registrations = [
      host.registerResource({
        when: { minorMode: MODE_ID },
        name: 'doompi-use-loop',
        kind: 'skill',
        read: () => resource(),
      }),
      host.registerActivity({ when: { minorMode: MODE_ID }, name: 'doompi-loop', start: startActivity }),
      host.registerCommand({
        when: { minorMode: MODE_ID },
        name: START_COMMAND_NAME,
        description: 'Start a registered loop.',
        async execute(args, execution) {
          if (!launchers) throw new Error('Loop activity is not active.');
          const available = launchers.listLaunchers();
          const selected = await execution.client.request({
            kind: 'select',
            title: 'Choose a loop launcher',
            options: available.map((entry) => ({ label: entry.label, value: entry.id })),
          });
          const launcherId = args.trim() || (typeof selected === 'string' ? selected : '');
          if (!launcherId) return;
          const instance = await launchers.launch(launcherId);
          publishMode();
          await notify(execution, instance ? `Loop '${instance.instanceId}' started.` : 'Loop launch was cancelled.');
        },
      }),
      host.registerCommand({
        when: { minorMode: MODE_ID },
        name: LIST_COMMAND_NAME,
        description: 'List and stop active loops.',
        async execute(_args, execution) {
          if (!launchers) throw new Error('Loop activity is not active.');
          const instances = launchers.listInstances();
          await notify(execution, instances.length === 0 ? 'No loops are active.' : JSON.stringify(instances, null, 2));
        },
      }),
      host.registerHook({
        when: { minorMode: MODE_ID },
        event: 'session_shutdown',
        async handle() {
          await launchers?.stopAll('Headless session shutdown.');
        },
      }),
    ];
    return () => {
      modeOwner?.dispose();
      void defaultRegistration?.dispose('Headless loop facet disposed.');
      void launchers?.dispose('Headless loop facet disposed.');
      registrations.forEach((registration) => registration.dispose());
    };
  },
};

export default loopHeadlessFacet;
