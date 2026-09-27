import type { DoomHeadlessExecutionContext, DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { readPackageResource, type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';
import { defineMinorMode, serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { Cron } from 'croner';

import { LIST_COMMAND_NAME } from '../../constants/loop';
import { MODE_STATUS_ID, PACKAGE_SOURCE } from '../../constants/piLoop';
import { DOOM_LOOP_LAUNCHERS_SERVICE, type LoopLaunchRequest } from '../../schemas/loopLaunchers';
import { CronLoopSchema, IntervalLoopSchema, parseCronLoop, parseIntervalLoop } from '../../schemas/loopTools';
import { formatLoopStatusView, LOOP_VIEW_STATUS_KEY } from '../../types/loopView';
import { createDoomLoopLaunchersService } from '../loopLaunchers';
import { createLoopTools } from '../loopTools';
import type { LoopToolsRoot } from '../loopTools/type';

export type LoopServerState = DoomServerSessionPlugin & LoopToolsRoot;

/** Loops are set by the agent, so a launch always carries its configuration. */
function prepareLoop(request: LoopLaunchRequest, cron: boolean) {
  if (request.input === undefined) throw new Error('Loop configuration is required. Ask the agent to set the loop.');
  return cron ? parseCronLoop(request.input) : parseIntervalLoop(request.input);
}

export function createSessionState(host: DoomHeadlessHostService): LoopServerState {
  const launchers = createDoomLoopLaunchersService({
    generation: `${host.context.sessionId}:loop-launchers`,
    createInstanceId: () => crypto.randomUUID(),
    timestamp: () => new Date().toISOString(),
  });
  let disposed = false;
  const modeSelected = (): boolean =>
    !disposed && (host.context.selection.state?.['minor-mode'] ?? []).includes(MODE_STATUS_ID);
  const publishView = (): void =>
    host.context.client.setStatus(LOOP_VIEW_STATUS_KEY, formatLoopStatusView(launchers.listInstances()));
  const modeOwner = defineMinorMode({
    descriptor: {
      source: PACKAGE_SOURCE,
      id: MODE_STATUS_ID,
      label: 'Loop',
      description: 'Give the agent tools to create, inspect, and stop session loops.',
      order: 60,
      actions: [
        {
          id: 'activate',
          label: 'Activate',
          description: 'Expose loop tools to the agent.',
          contexts: ['headless'],
          parameters: [],
        },
        {
          id: 'deactivate',
          label: 'Deactivate',
          description: 'Hide agent loop tools. Existing loops and manual controls remain available.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    state: () => ({
      activation: modeSelected() ? 'active' : 'inactive',
      condition: 'ready',
      ...(modeSelected() ? { detail: `${launchers.listInstances().length} loops`, color: 'accent' } : {}),
      actions: [
        {
          id: 'activate',
          enabled: !modeSelected(),
          ...(modeSelected() ? { disabledReason: 'Loop mode is already active.' } : {}),
        },
        {
          id: 'deactivate',
          enabled: modeSelected(),
          ...(modeSelected() ? {} : { disabledReason: 'Loop mode is not active.' }),
        },
      ],
    }),
    async handleAction(_runtime, actionId, _arguments, { signal }) {
      signal.throwIfAborted();
      if (actionId !== 'activate' && actionId !== 'deactivate')
        throw new Error(`Unknown loop mode action: ${actionId}`);
      const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== MODE_STATUS_ID);
      await host.changeSelection({
        axis: 'state',
        key: 'minor-mode',
        values: actionId === 'activate' ? [...modes, MODE_STATUS_ID] : modes,
      });
      modeOwner.publish();
      return {
        message:
          actionId === 'activate' ? 'Loop tools activated.' : 'Loop tools deactivated. Existing loops are unchanged.',
      };
    },
  }).createOwner(undefined);
  const publish = (): void => {
    if (disposed) return;
    modeOwner.publish();
    publishView();
  };
  const unsubscribe = launchers.subscribe(publish);
  let submitting = false;
  for (const cron of [false, true]) {
    launchers.register({
      id: cron ? 'doompi.cron' : 'doompi.default',
      source: PACKAGE_SOURCE,
      label: cron ? 'Cron loop' : 'Default loop',
      description: cron
        ? 'Run a prompt on a five-field cron schedule.'
        : 'Run a prompt in this session on an interval.',
      inputSchema: { ...(cron ? CronLoopSchema : IntervalLoopSchema) },
      async launch(request) {
        const execution = host.context;
        const prepared = prepareLoop(request, cron);
        if (!prepared || request.signal.aborted) return undefined;
        let stopped = false;
        const tick = async (): Promise<void> => {
          if (stopped || request.signal.aborted || submitting) return;
          submitting = true;
          try {
            const activity = await execution.session.activity();
            if (stopped || request.signal.aborted || !activity.isIdle || activity.hasPendingMessages) return;
            await execution.session.prompt(prepared.prompt);
          } catch (error) {
            await execution.client.notify({
              body: `Loop pass failed: ${error instanceof Error ? error.message : String(error)}`,
              level: 'warning',
            });
          } finally {
            submitting = false;
          }
        };
        let stopTimer: () => void;
        let detail: string;
        if ('cron' in prepared) {
          const job = new Cron(prepared.cron, { timezone: prepared.timezone, unref: true }, tick);
          if (job.nextRun() === null) {
            job.stop();
            throw new Error('Cron expression has no future run.');
          }
          stopTimer = () => {
            job.stop();
          };
          detail = `${prepared.cron} (${prepared.timezone})`;
        } else {
          const timer = setInterval(() => {
            void tick();
          }, prepared.intervalSeconds * 1000);
          timer.unref?.();
          stopTimer = () => clearInterval(timer);
          detail = `every ${prepared.intervalSeconds}s`;
          void tick();
        }
        return {
          instanceId: request.instanceId,
          label: cron ? 'Cron loop' : 'Default loop',
          detail,
          stop() {
            stopped = true;
            stopTimer();
          },
        };
      },
    });
  }
  const loopTools = createLoopTools(
    () => launchers,
    () => {
      if (!modeSelected()) throw new Error('Enable Loop minor mode before using agent loop tools.');
    },
  ).map((tool) => ({
    ...tool,
    when: { state: { 'minor-mode': MODE_STATUS_ID }, attribution: { kind: 'minor' as const, mode: MODE_STATUS_ID } },
  }));
  return {
    loopTools,
    services: [
      (context) => {
        context.plugin((provider) => {
          provider.provide(DOOM_LOOP_LAUNCHERS_SERVICE, launchers);
        });
        context.effect(() => host.subscribeSelection(publish));
      },
      serverMinorModes([modeOwner]),
    ],
    resources: [
      {
        when: { state: { 'minor-mode': MODE_STATUS_ID }, attribution: { kind: 'minor', mode: MODE_STATUS_ID } },
        name: 'doompi-use-loop',
        kind: 'skill',
        read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-loop/SKILL.md'),
      },
    ],
    activities: [
      {
        name: 'doompi-loop',
        async start() {
          publish();
          return async () => {
            await launchers.stopAll('Session loop activity stopped.');
            publish();
          };
        },
      },
    ],
    commands: [
      {
        name: LIST_COMMAND_NAME,
        description: 'List or stop session loops. Usage: /loops [stop instanceId].',
        async execute(args: string, execution: DoomHeadlessExecutionContext) {
          const parts = args.trim().split(/\s+/u);
          if (parts[0] === 'stop' && parts.length === 2) {
            const stopped = await launchers.stop(parts[1]!, 'Stopped manually.');
            await execution.client.notify({
              body: stopped ? 'Loop stopped.' : 'Loop instance was not active.',
              level: 'info',
            });
            return;
          }
          if (args.trim()) throw new Error('Usage: /loops [stop instanceId]');
          const instances = launchers.listInstances();
          await execution.client.notify({
            body: instances.length === 0 ? 'No loops are active.' : JSON.stringify(instances, null, 2),
            level: 'info',
          });
        },
      },
    ],
    hooks: [
      {
        event: 'session_start',
        async handle() {
          publish();
        },
      },
      {
        event: 'session_shutdown',
        async handle() {
          await launchers.stopAll('Headless session shutdown.');
        },
      },
    ],
    onStart: publish,
    async onDispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      await launchers.dispose('Headless loop facet disposed.');
    },
  };
}
