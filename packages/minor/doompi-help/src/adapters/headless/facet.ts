import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function readResource(file: string): Promise<string> {
  try {
    return await readFile(new URL(file, PACKAGE_ROOT), 'utf8');
  } catch {
    return '(resource unavailable)';
  }
}

export const helpHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resources: DoomHeadlessResource[] = [
      { name: 'doompi-help', kind: 'context', read: () => readResource('llms.txt') },
      { name: 'doompi-use-help', kind: 'skill', read: () => readResource('src/prompts/doompi-use-help/SKILL.md') },
    ];
    const command: DoomHeadlessCommand = {
      name: 'doom-help',
      description: 'Show DoomPi help resources available in this session.',
      async execute(_args, execution) {
        await execution.client.notify({ title: 'DoomPi help', body: await readResource('llms.txt'), level: 'info' });
      },
    };
    const registrations = [
      ...resources.map((resource) => host.registerResource(resource)),
      host.registerCommand(command),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
