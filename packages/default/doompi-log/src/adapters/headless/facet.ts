import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessHook,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';

const PACKAGE_SOURCE = '@agimon-ai/doompi-log';

export const logHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    let telemetry: DoomTelemetry | undefined;
    const resource: DoomHeadlessResource = {
      name: 'doompi/log-status',
      kind: 'context',
      read: (execution) =>
        JSON.stringify(
          {
            sessionId: execution.sessionId,
            active: telemetry !== undefined,
            status: telemetry?.status(),
          },
          null,
          2,
        ),
    };
    const activity: DoomHeadlessActivity = {
      name: PACKAGE_SOURCE,
      start(execution) {
        telemetry = createDoomTelemetry({
          serviceName: 'pi',
          packageName: PACKAGE_SOURCE,
          cwd: execution.cwd,
          env: { ...process.env, PI_SESSION_ID: execution.sessionId },
          enableLogs: true,
          enableTraces: true,
        });
        return async () => {
          const current = telemetry;
          telemetry = undefined;
          await current?.shutdown();
        };
      },
    };
    const command: DoomHeadlessCommand = {
      name: 'log-metrics',
      description: 'Show headless telemetry sink status.',
      async execute(_args, execution) {
        await execution.client.notify({
          title: 'DoomPi telemetry',
          body: JSON.stringify(telemetry?.status() ?? { active: false }, null, 2),
          level: 'info',
        });
      },
    };
    const hooks: DoomHeadlessHook[] = [
      {
        event: 'session_start',
        handle(_event, execution) {
          void telemetry?.recordEvent('pi.session.started', { 'pi.session.id': execution.sessionId });
        },
      },
      {
        event: 'agent_settled',
        handle(_event, execution) {
          void telemetry?.recordEvent('pi.agent.settled', { 'pi.session.id': execution.sessionId });
        },
      },
      {
        event: 'session_shutdown',
        handle(_event, execution) {
          void telemetry?.recordEvent('pi.session.stopped', { 'pi.session.id': execution.sessionId });
          execution.client.setStatus('doompi-log', undefined);
        },
      },
    ];
    const registrations = [
      host.registerResource(resource),
      host.registerActivity(activity),
      host.registerCommand(command),
      ...hooks.map((hook) => host.registerHook(hook)),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
