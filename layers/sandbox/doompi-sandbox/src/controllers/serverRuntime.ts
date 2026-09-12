import type { DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';
import { createSandboxCommand } from './doomSandboxCommand';
import { type DoomHeadlessActivity, type DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';
import { DefaultSandboxExtensionService } from '../services/extensionService';
import { startBroker, type RunningBroker } from '../services/brokerHost';

import { readPackageResource } from '../services/packageResource';
import { BROKER_DISABLED_ENV, DISABLED_VALUE, BROKER_STATUS_SOURCE } from '../constants/sandbox';

export function createSandboxServerRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): DoomServerSessionPlugin {
  const service = new DefaultSandboxExtensionService(environment);

  const resources: DoomHeadlessResource[] = [
    { name: 'doompi-sandbox', kind: 'context', read: () => readPackageResource('llms.txt') },
    {
      name: 'doompi-use-sandbox',
      kind: 'skill',
      read: () => readPackageResource('src/prompts/doompi-use-sandbox/SKILL.md'),
    },
    { name: 'doompi-sandbox-readme', kind: 'context', read: () => readPackageResource('README.md') },
  ];

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

  return { resources, activities: [activity], commands: [createSandboxCommand(service)] };
}
