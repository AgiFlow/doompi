import { type PiPluginContributions } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { requireHarnessRoot } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import {
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
import { createSkillsCommand, type SkillsCommandDependencies } from './skillsCommand';
import { SKILLS_LEADER_CONTRIBUTION } from '../types/skills';
import { createActiveHelpSkillView } from '../services/helpSkills';
import { createSkillReadiness, skillInventory } from './skillReadiness';

/**
 * The catalogue and the overlay load on first use.
 *
 * Discovery has to start with the session, but building the catalogue and
 * rendering it are only reached by `/skills`, so they stay off the startup path.
 */
function lazyModules() {
  let catalog: Promise<typeof import('../services/skillCatalog')> | undefined;
  let deferred: Promise<typeof import('../services/deferredSkills')> | undefined;
  return {
    catalog: () => (catalog ??= import('../services/skillCatalog')),
    deferred: () => (deferred ??= import('../services/deferredSkills')),
  };
}

interface SkillPluginConfig {
  readonly pi: ExtensionAPI;
  readonly openOverlay: SkillsCommandDependencies['openOverlay'];
}

export function createSkillRuntime({ pi, openOverlay }: SkillPluginConfig): PiPluginContributions {
  const load = lazyModules();
  let activeContext: Context | undefined;
  let activeSources: DoomSkillSourcesService | undefined;
  const bindConfig = (cordis: Context) => {
    cordis.inject([DOOM_CONFIG_SERVICE], (context) => {
      activeContext = context;
      return () => {
        if (activeContext === context) activeContext = undefined;
      };
    });
  };
  const requireRuntimeContext = (): Context => {
    if (!activeContext) throw new Error('Doom skill runtime is waiting for the session config service.');
    return activeContext;
  };
  const requireSkillSources = (): DoomSkillSourcesService => {
    if (!activeSources) throw new Error('Doom skill sources are waiting for the active session service.');
    return activeSources;
  };
  const bindSources = (cordis: Context) => {
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
  };
  const helpSkillView = createActiveHelpSkillView();

  const bindHelp = (cordis: Context) => {
    cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
      const help = requireDoomHelpService(helpContext);
      const unbind = helpSkillView.bind(help);
      return () => {
        unbind();
      };
    });
  };
  const bindUi = (cordis: Context) => {
    cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
      const contribution = requireDoomUiHub(uiContext).registerLeader(SKILLS_LEADER_CONTRIBUTION);
      return () => contribution.dispose();
    });
  };
  const readiness = createSkillReadiness(pi, helpSkillView, load.deferred, requireRuntimeContext);
  return {
    services: [bindConfig, bindSources, bindHelp, bindUi],
    commands: [
      createSkillsCommand({
        cordisContext: requireRuntimeContext,
        extensionSources: () => requireSkillSources().list(),
        inventory: async (ctx) => {
          return skillInventory(helpSkillView, readiness)(ctx);
        },
        repositoryRoot: async (_ctx: ExtensionContext) =>
          requireHarnessRoot(requireDoomConfigContext(requireRuntimeContext()).harness),
        buildCatalog: async (request) => (await load.catalog()).buildSkillCatalog(request),
        openOverlay,
      }),
    ],
    events: readiness.events,
    onStop: readiness.onStop,
    onDispose() {
      helpSkillView.dispose();
    },
  };
}
