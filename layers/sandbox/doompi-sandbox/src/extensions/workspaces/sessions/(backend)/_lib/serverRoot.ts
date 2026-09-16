import type { DoomHeadlessActivity } from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { BROKER_DISABLED_ENV, BROKER_STATUS_SOURCE, DISABLED_VALUE } from '../../../../../constants/sandbox';
import { startBroker, type RunningBroker } from '../../../../../services/brokerHost';
import { DefaultSandboxExtensionService } from '../../../../../services/extensionService';
import type { SandboxServerScope } from './sandboxScope';

export function createSandboxServerRoot({ agent }: DoomServerPluginContext) {
  if (!agent) return { value: {} as SandboxServerScope };
  const service = new DefaultSandboxExtensionService(agent.context.environment);
  let broker: RunningBroker | undefined;
  const activity: DoomHeadlessActivity = {
    name: BROKER_STATUS_SOURCE,
    async start(execution) {
      if (execution.environment[BROKER_DISABLED_ENV] === DISABLED_VALUE) return () => undefined;
      const started = await startBroker({
        environment: execution.environment,
        onDenied: (reason) => {
          void execution.client.notify({
            title: 'DoomPi sandbox broker',
            body: `Broker refused a call: ${reason}`,
            level: 'warning',
          });
        },
      });
      broker = started;
      if (started === undefined) return () => undefined;
      execution.client.setStatus(BROKER_STATUS_SOURCE, `provider broker: ${started.providers.join(', ')}`);
      return async () => {
        if (broker !== started) return;
        broker = undefined;
        execution.client.setStatus(BROKER_STATUS_SOURCE, undefined);
        await started.stop();
      };
    },
  };
  return { value: { service }, activities: [activity] };
}
