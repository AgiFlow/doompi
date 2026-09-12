import { type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE, type DoomHelpService } from '@agimon-ai/doompi-core/help';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import { createHelpCommand } from './helpCommand';
import { registerHelpModeIntegration, registerHelpUiIntegration } from './helpMode';
import { createHelpRuntime, type HelpRuntimeOptions } from '../services/helpRuntime';
import type { HelpActivationService } from '../types/help';

const PACKAGE_SOURCE = '@agimon-ai/doompi-help';

/** Install Help resources into its host-owned Cordis plugin fiber. */
export function createHelpPiRuntime(
  options: HelpRuntimeOptions,
  moduleUrl: string,
): PiPluginContributions<HelpRuntimeOptions> {
  let activeActivation: HelpActivationService | undefined;

  return {
    services: [
      (cordis: Context) => {
        cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
          const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
          const service: DoomHelpService = createDoomHelpService(`${session.generation}:help`);
          const selfContribution = service.register({
            source: PACKAGE_SOURCE,
            moduleUrl,
            skills: [
              {
                name: 'doompi-use-help',
                description:
                  'Use Doom Pi Help to activate package guidance, load exact-version skills, and diagnose unavailable or conflicting contributions.',
              },
            ],
          });
          const runtime = createHelpRuntime(service, options);
          activeActivation = runtime.activation;
          try {
            sessionContext.provide(DOOM_HELP_SERVICE, service);
            sessionContext.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
              const mode = registerHelpModeIntegration(requireMinorModeCatalog(modeContext), runtime.activation);
              return () => mode.dispose();
            });
            sessionContext.inject([DOOM_UI_HUB_SERVICE], (uiContext) =>
              registerHelpUiIntegration(requireDoomUiHub(uiContext), runtime.activation),
            );
          } catch (error) {
            if (activeActivation === runtime.activation) activeActivation = undefined;
            runtime.dispose();
            selfContribution.dispose();
            service.dispose();
            throw error;
          }
          return () => {
            if (activeActivation === runtime.activation) activeActivation = undefined;
            runtime.dispose();
            selfContribution.dispose();
            service.dispose();
          };
        });
      },
    ],
    commands: [
      createHelpCommand(() => {
        if (!activeActivation) throw new Error('Doom Help is waiting for the active session service.');
        return activeActivation;
      }),
    ],
    onStop() {
      activeActivation = undefined;
    },
  };
}
