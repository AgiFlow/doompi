import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { buildPersonaPrompt, loadProfiles, resolveProfile } from '@agimon-ai/doompi-config/profiles';
import { PROFILE_COMMAND, profileItems, profileTitle } from '../../services/profileText.ts';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function readOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

async function readSelectedPersona(execution: {
  readonly repoRoot: string;
  readonly selection: { readonly profile?: string };
}): Promise<string> {
  const name = execution.selection.profile;
  if (!name) return '(no active profile)';
  const profile = resolveProfile(execution.repoRoot, name);
  const prompt = buildPersonaPrompt(profile.personaRoot, profile.persona);
  if (!prompt) throw new Error(`Profile "${name}" has no readable persona text`);
  return prompt;
}

export const profileHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resources: DoomHeadlessResource[] = [
      {
        name: 'doompi/profile-config',
        kind: 'context',
        read: (execution) => readSelectedPersona(execution),
      },
      {
        name: 'doompi-author-profile',
        kind: 'skill',
        read: () =>
          readOrFallback(
            new URL('src/prompts/doompi-author-profile/SKILL.md', PACKAGE_ROOT).pathname,
            '(resource unavailable)',
          ),
      },
    ];
    const command: DoomHeadlessCommand = {
      name: PROFILE_COMMAND,
      description: 'Show or change the active DoomPi profile.',
      async execute(args, execution) {
        const profiles = loadProfiles(execution.repoRoot);
        let requested = args.trim();
        if (!requested) {
          const selected = await execution.client.request({
            kind: 'select',
            title: profileTitle(execution.selection.profile),
            options: profileItems(profiles),
          });
          if (typeof selected !== 'string' || !selected) return;
          requested = selected;
        }
        if (!profiles.some(({ name }) => name === requested)) throw new Error(`Unknown profile: ${requested}`);
        if (requested === execution.selection.profile) return;
        await host.select({ profile: requested });
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
