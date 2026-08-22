import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  createDoomHelpService,
  DOOM_HELP_SERVICE,
  type DoomHelpService,
} from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerHelpCommand } from '../../adapters/pi/helpCommand.ts';
import { registerHelpModeIntegration, registerHelpUiIntegration } from '../../adapters/pi/helpMode.ts';
import { createHelpRuntime, type HelpRuntimeOptions } from '../../container/index.ts';
import type { HelpActivationService } from '../../types/help.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-help';

/** Install Help resources into its host-owned Cordis plugin fiber. */
export function installHelpRuntime(cordis: Context, pi: ExtensionAPI, options: HelpRuntimeOptions = {}): void {
  let activeActivation: HelpActivationService | undefined;
  registerHelpCommand(pi, () => {
    if (!activeActivation) throw new Error('Doom Help is waiting for the active session service.');
    return activeActivation;
  });

  cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
    const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
    const service: DoomHelpService = createDoomHelpService(`${session.generation}:help`);
    const selfContribution = service.register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
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
}

/** The package's single standard Pi factory, including optional typed Doom integrations. */
export async function helpExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(helpPlugin, { pi });
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

interface HelpPluginConfig {
  readonly pi: ExtensionAPI;
}

function helpPlugin(cordis: Context, config: HelpPluginConfig): void {
  installHelpRuntime(cordis, config.pi);
}

export default helpExtension;
