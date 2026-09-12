import { readFile } from 'node:fs/promises';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { DeferredSkillLoader, expandDeferredSkillCommand } from '../deferredSkills.ts';
import path from 'node:path';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { SKILLS_COMMAND } from '../../types/skills.ts';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function readOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export const skillHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  async apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const execution = host.context;
    const state = readHarnessState(execution.environment);
    const inventory = await new DeferredSkillLoader({
      cwd: execution.cwd,
      skillPaths: [...(state.skillDirectories ?? []), path.join(execution.repoRoot, '.doom', 'skills')],
    }).ready();
    const catalog = formatSkillsForPrompt(inventory.skills) || '(no discovered skills)';
    const resources: DoomHeadlessResource[] = [
      {
        name: 'doompi/skills',
        kind: 'skill',
        read: () => catalog,
      },
      {
        name: 'doompi-author-skill',
        kind: 'skill',
        read: () =>
          readOrFallback(
            new URL('src/prompts/doompi-author-skill/SKILL.md', PACKAGE_ROOT).pathname,
            '(resource unavailable)',
          ),
      },
      {
        name: 'doompi-use-skill',
        kind: 'skill',
        read: () =>
          readOrFallback(
            new URL('src/prompts/doompi-use-skill/SKILL.md', PACKAGE_ROOT).pathname,
            '(resource unavailable)',
          ),
      },
    ];
    const command: DoomHeadlessCommand = {
      name: SKILLS_COMMAND,
      description: 'List discovered skills or invoke one by name.',
      async execute(args, execution) {
        const requested = args.trim();
        if (requested) {
          await execution.session.prompt(expandDeferredSkillCommand(`/skill:${requested}`, inventory.skills));
          return;
        }
        await execution.client.notify({
          title: 'DoomPi skills',
          body: catalog,
          level: 'info',
        });
      },
    };
    const registrations = [
      ...resources.map((resource) => host.registerResource(resource)),
      host.registerCommand(command),
      ...inventory.skills.map((skill) =>
        host.registerCommand({
          name: `skill:${skill.name}`,
          description: skill.description,
          execute: async (args, execution) => {
            const text = `/skill:${skill.name}${args ? ` ${args}` : ''}`;
            const expanded = expandDeferredSkillCommand(text, inventory.skills);
            if (expanded === text) throw new Error(`Skill '${skill.name}' is no longer readable.`);
            await execution.session.prompt(expanded);
          },
        }),
      ),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
