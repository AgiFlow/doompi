import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { planModeExtension } from '../../services/planMode.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-plan';

/** Install Plan state and external resources into its host-owned Cordis plugin fiber. */
export function installPlanRuntime(cordis: Context, pi: ExtensionAPI): void {
  planModeExtension(cordis, pi);
}

/** The package's single standard Pi factory, including all optional typed Doom integrations. */
export async function activatePlanExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(planPlugin, { pi });
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

interface PlanPluginConfig {
  readonly pi: ExtensionAPI;
}

function planPlugin(cordis: Context, config: PlanPluginConfig): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-plan',
          description:
            'Use Doom Pi Plan to draft reviewable normal, debug, or Fable-assisted plans, persist them, and exit safely.',
        },
      ],
    });
    return () => contribution.dispose();
  });
  installPlanRuntime(cordis, config.pi);
}

export default activatePlanExtension;
