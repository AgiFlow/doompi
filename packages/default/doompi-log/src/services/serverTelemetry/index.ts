import {
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessHook,
} from '@agimon-ai/doompi-core/headless';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';

const PACKAGE_SOURCE = '@agimon-ai/doompi-log';

export function createServerTelemetry() {
  let telemetry: DoomTelemetry | undefined;
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
  // Telemetry sink status is operator information, not model-actionable. The
  // log-metrics command below serves it on demand instead of every prompt build.
  return { activities: [activity], commands: [command], hooks };
}
