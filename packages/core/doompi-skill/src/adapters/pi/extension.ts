import { requireHarnessRoot } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import {
  createDoomSkillSourcesService,
  DOOM_SKILL_SOURCES_SERVICE,
  type DoomSkillSourcesService,
} from '@agimon-ai/doompi-extension-contracts/skills';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerSkillsCommand } from '../../commands/skillsCommand.ts';
import { LEADER_SOURCE, SKILLS_LEADER_CONTRIBUTION } from '../../types/skills.ts';
import { createActiveHelpSkillView } from '../helpSkills.ts';
import { registerSkillReadiness, skillInventory } from './skillReadiness.ts';

/**
 * The catalogue and the overlay load on first use.
 *
 * Discovery has to start with the session, but building the catalogue and
 * rendering it are only reached by `/skills`, so they stay off the startup path.
 */
function lazyModules() {
  let catalog: Promise<typeof import('../skillCatalog.ts')> | undefined;
  let deferred: Promise<typeof import('../deferredSkills.ts')> | undefined;
  let overlay: Promise<typeof import('../../tui/skillsOverlay.ts')> | undefined;
  return {
    catalog: () => (catalog ??= import('../skillCatalog.ts')),
    deferred: () => (deferred ??= import('../deferredSkills.ts')),
    overlay: () => (overlay ??= import('../../tui/skillsOverlay.ts')),
  };
}

interface SkillPluginConfig {
  readonly pi: ExtensionAPI;
}

function skillPlugin(cordis: Context, { pi }: SkillPluginConfig): void {
  const load = lazyModules();
  let activeContext: Context | undefined;
  let activeSources: DoomSkillSourcesService | undefined;
  cordis.inject([DOOM_CONFIG_SERVICE], (context) => {
    activeContext = context;
    return () => {
      if (activeContext === context) activeContext = undefined;
    };
  });
  const requireRuntimeContext = (): Context => {
    if (!activeContext) throw new Error('Doom skill runtime is waiting for the session config service.');
    return activeContext;
  };
  const requireSkillSources = (): DoomSkillSourcesService => {
    if (!activeSources) throw new Error('Doom skill sources are waiting for the active session service.');
    return activeSources;
  };
  cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
    const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
    const service = createDoomSkillSourcesService(`${session.generation}:skill-sources`);
    sessionContext.provide(DOOM_SKILL_SOURCES_SERVICE, service);
    activeSources = service;
    return () => {
      if (activeSources === service) activeSources = undefined;
      service.dispose();
    };
  });

  const helpSkillView = createActiveHelpSkillView();
  cordis.effect(() => () => helpSkillView.dispose(), `${LEADER_SOURCE}/help`);
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const help = requireDoomHelpService(helpContext);
    const contribution = help.register({
      source: LEADER_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-skill',
          description:
            'Author and distribute DoomPi agent skills. Use when creating a SKILL.md, adding supporting references or scripts, contributing a runtime skill directory through Cordis, or publishing activation-gated Help prompts from a DoomPi package.',
        },
        {
          name: 'doompi-use-skill',
          description:
            "Use DoomPi's skill catalog and deferred discovery. Use when browsing available skills, invoking /skill:name, understanding Help and extension-owned skill groups, or diagnosing why a skill is absent or shadowed.",
        },
      ],
    });
    const unbind = helpSkillView.bind(help);
    return () => {
      unbind();
      contribution.dispose();
    };
  });
  const readiness = registerSkillReadiness(pi, helpSkillView, load.deferred, requireRuntimeContext);
  registerSkillsCommand(pi, {
    cordisContext: requireRuntimeContext,
    extensionSources: () => requireSkillSources().list(),
    inventory: skillInventory(helpSkillView, readiness),
    repositoryRoot: async (_ctx: ExtensionContext) =>
      requireHarnessRoot(requireDoomConfigContext(requireRuntimeContext()).harness),
    buildCatalog: async (request) => (await load.catalog()).buildSkillCatalog(request),
    openOverlay: async (ctx, options) => (await load.overlay()).openSkillsOverlay(ctx, options),
  });

  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    const contribution = requireDoomUiHub(uiContext).registerLeader(SKILLS_LEADER_CONTRIBUTION);
    return () => contribution.dispose();
  });
}

/** The package's single standard Pi factory. */
export async function skillsExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, LEADER_SOURCE);
  const fiber = connection.root.plugin(skillPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default skillsExtension;
