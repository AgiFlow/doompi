import {
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessHook,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';

const PACKAGE_SOURCE = '@agimon-ai/doompi-log';

export function createServerTelemetry() {
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
        env: { ...execution.environment, PI_SESSION_ID: execution.sessionId },
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
  return { resources: [resource], activities: [activity], commands: [command], hooks };
}
