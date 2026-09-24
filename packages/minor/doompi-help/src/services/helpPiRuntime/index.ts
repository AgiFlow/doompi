import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordisHost';
import { createDoomHelpService, DOOM_HELP_SERVICE, type DoomHelpService } from '@agimon-ai/doompi-core/help';
import { createPiHelpToolGate } from '@agimon-ai/doompi-core/help';
import type { PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';
import {
  DOOM_TOOL_SURFACE_SERVICE,
  requireDoomToolSurface,
  type DoomToolSurfaceService,
} from '@agimon-ai/doompi-core/toolSurface';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/uiHub';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';

import { HELP_PACKAGE_SOURCE, HELP_SKILL, HELP_STATUS_TOOL_NAME } from '../../constants/help';
import type { HelpActivationService } from '../../types/help';
import { createHelpCommand } from '../helpCommand';
import { helpMinorModeState, registerHelpModeIntegration, registerHelpUiIntegration } from '../helpMode';
import { createHelpRuntime, type HelpRuntimeOptions } from '../helpRuntime';
import { createHelpStatusTool, helpStatusDetail, piHelpStatus } from '../helpStatus';

/** Install Help resources into its host-owned Cordis plugin fiber. */
export function createHelpPiRuntime(
  options: HelpRuntimeOptions,
  moduleUrl: string,
): PiPluginContributions<HelpRuntimeOptions> {
  let activeActivation: HelpActivationService | undefined;
  let activeService: DoomHelpService | undefined;
  let activeSurface: DoomToolSurfaceService | undefined;
  const gate = createPiHelpToolGate(HELP_PACKAGE_SOURCE, [HELP_STATUS_TOOL_NAME]);
  return {
    services: [
      ...gate.services,
      (cordis: Context) => {
        cordis.inject([DOOM_TOOL_SURFACE_SERVICE], (child) => {
          const surface = requireDoomToolSurface(child);
          activeSurface = surface;
          return () => {
            if (activeSurface === surface) activeSurface = undefined;
          };
        });
        cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
          const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
          const service = createDoomHelpService(`${session.generation}:help`);
          const selfContribution = service.register({ source: HELP_PACKAGE_SOURCE, moduleUrl, skills: [HELP_SKILL] });
          const runtime = createHelpRuntime(service, options);
          activeActivation = runtime.activation;
          activeService = service;
          const dispose = () => {
            if (activeActivation === runtime.activation) activeActivation = undefined;
            if (activeService === service) activeService = undefined;
            runtime.dispose();
            selfContribution.dispose();
            service.dispose();
          };
          try {
            sessionContext.plugin((providerContext) => {
              providerContext.provide(DOOM_HELP_SERVICE, service);
            });
            sessionContext.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
              const mode = registerHelpModeIntegration(requireMinorModeCatalog(modeContext), runtime.activation);
              let closed = false;
              let sequence = 0;
              const publishDetail = async () => {
                const operation = ++sequence;
                const snapshot = service.getSnapshot();
                const accepted = await service.inspectSkills().catch(() => undefined);
                if (closed || operation !== sequence || snapshot.revision !== service.getSnapshot().revision) return;
                const report = piHelpStatus(snapshot, accepted, activeSurface?.inspect() ?? []);
                const state = helpMinorModeState(runtime.activation.getState());
                mode.mode.publish({
                  ...state,
                  ...(state.activation === 'active'
                    ? {
                        detail: helpStatusDetail(report),
                        condition: report.activation === 'degraded' ? 'degraded' : 'ready',
                      }
                    : {}),
                });
              };
              const unsubscribe = runtime.activation.subscribe(() => {
                void publishDetail();
              });
              modeContext.inject([DOOM_TOOL_SURFACE_SERVICE], (child) => {
                const surface = requireDoomToolSurface(child);
                const off = surface.subscribe(() => {
                  void publishDetail();
                });
                void publishDetail();
                return off;
              });
              void publishDetail();
              return () => {
                closed = true;
                unsubscribe();
                mode.dispose();
              };
            });
            sessionContext.inject([DOOM_UI_HUB_SERVICE], (uiContext) =>
              registerHelpUiIntegration(requireDoomUiHub(uiContext), runtime.activation),
            );
          } catch (error) {
            dispose();
            throw error;
          }
          return dispose;
        });
      },
    ],
    commands: [
      createHelpCommand(() => {
        if (!activeActivation) throw new Error('Doom Help is waiting for the active session service.');
        return activeActivation;
      }),
    ],
    tools: [
      createHelpStatusTool(
        async () => {
          const service = activeService;
          const surface = activeSurface;
          if (!service || !surface) throw new Error('Help is waiting for the active session services.');
          const accepted = await service.inspectSkills().catch(() => undefined);
          if (service !== activeService || surface !== activeSurface) throw new Error('The Help session changed.');
          return piHelpStatus(service.getSnapshot(), accepted, surface.inspect());
        },
        (signal) => gate.assertActive(HELP_STATUS_TOOL_NAME, signal),
      ),
    ],
    onStart: gate.onStart,
    onStop() {
      activeActivation = undefined;
      activeService = undefined;
    },
  };
}
