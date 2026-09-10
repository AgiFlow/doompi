import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { resolvePromptsDirectory } from '../node/promptStore.ts';
import { parsePromptDocument } from '../../services/savedPromptDocument.ts';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function savedPrompts(): Promise<readonly { name: string; text: string; description: string }[]> {
  const directory = resolvePromptsDirectory();
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(directory, { withFileTypes: true });
    const prompts = [] as { name: string; text: string; description: string }[];
    for (const entry of entries
      .filter((candidate) => candidate.isFile() && candidate.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name.slice(0, -3);
      prompts.push(parsePromptDocument(name, await readFile(`${directory}/${entry.name}`, 'utf8')));
    }
    return prompts;
  } catch {
    return [];
  }
}

export const promptHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resource: DoomHeadlessResource = {
      name: 'doompi/prompts',
      kind: 'prompt',
      read: async () => JSON.stringify(await savedPrompts(), null, 2),
    };
    const skill: DoomHeadlessResource = {
      name: 'doompi-use-prompt',
      kind: 'skill',
      read: async () => {
        try {
          return await readFile(new URL('src/prompts/doompi-use-prompt/SKILL.md', PACKAGE_ROOT), 'utf8');
        } catch {
          return '(resource unavailable)';
        }
      },
    };
    const command: DoomHeadlessCommand = {
      name: 'prompts',
      description: 'List saved prompts or run one by name.',
      async execute(args, execution) {
        const prompts = await savedPrompts();
        const requested = args.trim();
        if (!requested) {
          await execution.client.notify({
            title: 'DoomPi prompts',
            body: prompts.map((prompt) => `/${prompt.name}: ${prompt.description}`).join('\n') || '(no saved prompts)',
            level: 'info',
          });
          return;
        }
        const prompt = prompts.find((candidate) => candidate.name === requested);
        if (!prompt) {
          await execution.client.notify({ body: `Saved prompt not found: ${requested}`, level: 'warning' });
          return;
        }
        await execution.session.prompt(prompt.text);
      },
    };
    const registrations = [
      host.registerResource(resource),
      host.registerResource(skill),
      host.registerCommand(command),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
