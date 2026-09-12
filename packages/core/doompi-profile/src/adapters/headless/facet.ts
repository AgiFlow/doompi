import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { DOOM_PROFILE_IDENTITY_ENTRY_TYPE } from '@agimon-ai/doompi-extension-contracts/profile-identity';
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

async function publishSelectedIdentity(execution: DoomHeadlessExecutionContext, profile: string): Promise<void> {
  const identity = resolveProfile(execution.repoRoot, profile).identity;
  await execution.session.appendCustomEntry(DOOM_PROFILE_IDENTITY_ENTRY_TYPE, {
    profile,
    ...(identity?.name === undefined ? {} : { name: identity.name }),
    ...(identity?.icon === undefined ? {} : { icon: identity.icon }),
  });
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
        await host.changeSelection({ axis: 'profile', profile: requested });
        await publishSelectedIdentity(execution, requested);
      },
    };
    const registrations = [
      ...resources.map((resource) => host.registerResource(resource)),
      host.registerCommand(command),
      host.registerHook({
        event: 'session_start',
        async handle(_event, execution) {
          const profile = execution.selection.profile;
          if (profile !== undefined) await publishSelectedIdentity(execution, profile);
        },
      }),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
