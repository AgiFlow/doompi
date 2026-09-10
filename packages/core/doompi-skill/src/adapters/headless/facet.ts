import { readFile, readdir } from 'node:fs/promises';
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

async function skillCatalog(cwd: string): Promise<string> {
  const roots = [
    path.join(cwd, '.doom', 'skills'),
    ...(process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS?.split(path.delimiter) ?? []),
  ].filter(Boolean);
  const paths: string[] = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'SKILL.md') paths.push(path.join(entry.parentPath, entry.name));
      }
    } catch {
      // A missing optional skill root is an empty catalog, not a session failure.
    }
  }
  const documents = await Promise.all(
    paths.sort().map(async (filePath) => `## ${filePath}\n${await readFile(filePath, 'utf8')}`),
  );
  return documents.join('\n\n') || '(no discovered skills)';
}

export const skillHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resources: DoomHeadlessResource[] = [
      {
        name: 'doompi/skills',
        kind: 'skill',
        read: (execution) => skillCatalog(execution.cwd),
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
          await execution.session.prompt(`/skill:${requested}`);
          return;
        }
        await execution.client.notify({
          title: 'DoomPi skills',
          body: await skillCatalog(execution.cwd),
          level: 'info',
        });
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
