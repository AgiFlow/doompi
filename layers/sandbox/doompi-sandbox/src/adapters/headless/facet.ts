import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';
import { COMMAND_DESCRIPTION, COMMAND_NAME } from '../../schemas/sandboxCommands.ts';
import { DefaultSandboxExtensionService } from '../../services/extensionService.ts';
import { startBroker, type RunningBroker } from '../brokerHost.ts';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);
const BROKER_DISABLED_ENV = 'DOOMPI_SANDBOX_BROKER';
const DISABLED_VALUE = '0';
const BROKER_STATUS_SOURCE = 'doompi-sandbox-broker';

async function readPackageResource(name: string): Promise<string> {
  try {
    return await readFile(new URL(name, PACKAGE_ROOT), 'utf8');
  } catch {
    return `(resource unavailable: ${name})`;
  }
}

export const sandboxHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const service = new DefaultSandboxExtensionService(host.context.environment);
    let broker: RunningBroker | undefined;
    const resources: DoomHeadlessResource[] = [
      { name: 'doompi-sandbox', kind: 'context', read: () => readPackageResource('llms.txt') },
      {
        name: 'doompi-use-sandbox',
        kind: 'skill',
        read: () => readPackageResource('src/prompts/doompi-use-sandbox/SKILL.md'),
      },
      { name: 'doompi-sandbox-readme', kind: 'context', read: () => readPackageResource('README.md') },
    ];
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
    const command: DoomHeadlessCommand = {
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      async execute(_args, execution) {
        const result = await service.execute();
        await execution.client.notify({ body: result.message, level: result.level });
      },
    };
    const registrations = [
      ...resources.map((resource) => host.registerResource(resource)),
      host.registerActivity(activity),
      host.registerCommand(command),
    ];
    return () => {
      for (const registration of registrations.reverse()) registration.dispose();
    };
  },
};

export default sandboxHeadlessFacet;
