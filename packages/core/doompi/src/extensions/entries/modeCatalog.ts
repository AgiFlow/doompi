import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeActionResponse,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  consumeMinorModeReloadHandoff,
  discardMinorModeReloadHandoff,
  type MinorModeCatalogHost,
  DOOM_TRANSITION_SERVICE,
  requireDoomTransitionCoordinator,
  type TransitionSource,
} from '@agimon-ai/doompi-extension-contracts/transition';
import type { Context } from '@deepseek-ai/cordis';
import { createMinorModeCatalogHost } from '../../services/modeCatalog.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi/mode-catalog';
const HELP_CONTRIBUTION_SOURCE = '@agimon-ai/doompi';

function transitionSource(requesterSource: string): TransitionSource {
  if (requesterSource.includes('voice')) return 'voice';
  if (requesterSource.includes('leader')) return 'leader';
  if (requesterSource.includes('ui')) return 'ui';
  return 'system';
}

export async function modeCatalogExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(modeCatalogPlugin);
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    await connection.dispose();
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

function modeCatalogPlugin(cordis: Context): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: HELP_CONTRIBUTION_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-extension',
          description:
            'Create or update a DoomPi extension package inside the DoomPi monorepo or as an external npm package. Use for package layout, Pi discovery entries, shared Cordis lifecycle, package-owned Help, and extension verification.',
        },
      ],
    });
    return () => contribution.dispose();
  });

  cordis.inject([DOOM_CORDIS_SESSION_SERVICE, DOOM_TRANSITION_SERVICE], (sessionContext) => {
    const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
    const context = session.context;
    const coordinator = requireDoomTransitionCoordinator(sessionContext);
    const reloadSession = session.reason === 'reload';
    const sessionId = session.sessionId;
    const restoreSnapshot = reloadSession ? consumeMinorModeReloadHandoff(sessionId) : undefined;
    if (!reloadSession) discardMinorModeReloadHandoff(sessionId);
    const catalog: MinorModeCatalogHost = createMinorModeCatalogHost({
      sessionKind: context.hasUI && context.mode === 'tui' ? 'tui' : 'headless',
      context,
      restoreSnapshot,
      onRestorationError(error) {
        context.ui.notify(
          `Could not restore a minor mode after reload: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        );
      },
      async routeInvocation(request, requesterSource, invoke) {
        let response: MinorModeActionResponse | undefined;
        const result = await coordinator.execute(
          {
            sessionId: context.sessionManager.getSessionId(),
            hostGeneration: coordinator.hostGeneration,
            operationId: request.operationId,
            source: transitionSource(requesterSource),
            target: { axis: 'minor-mode', action: request, requesterSource },
          },
          async () => {
            response = await invoke();
            return 'applied';
          },
        );
        if (result.outcome !== 'applied' || !response) {
          throw new Error(`Minor-mode transition was ${result.outcome}: ${result.diagnostics.join(', ')}`);
        }
        return response;
      },
    });
    sessionContext.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, catalog);
    return () => catalog.dispose();
  });
}

export default modeCatalogExtension;
