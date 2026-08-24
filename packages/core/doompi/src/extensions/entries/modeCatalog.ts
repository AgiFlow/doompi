import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  DOOM_MINOR_MODE_ENTRY_TYPE,
  type MinorModeActionResponse,
  type MinorModeCatalogService,
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
import { projectMinorModes } from '../../services/minorModeProjection.ts';
import { createMinorModeCatalogHost } from '../../services/modeCatalog.ts';
import { registerMinorModeCommand } from './minorModeCommand.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi/mode-catalog';
const HELP_CONTRIBUTION_SOURCE = '@agimon-ai/doompi';
/** Registrations and state flips arrive in bursts; one entry covers a burst. */
const PROJECTION_SETTLE_MS = 50;

function transitionSource(requesterSource: string): TransitionSource {
  if (requesterSource.includes('voice')) return 'voice';
  if (requesterSource.includes('leader')) return 'leader';
  if (requesterSource.includes('ui')) return 'ui';
  return 'system';
}

export async function modeCatalogExtension(pi: ExtensionAPI): Promise<void> {
  // The command outlives any one session: it is registered once and reads the
  // catalog binding the session-scoped inject below sets and clears.
  const activeCatalog: { current: MinorModeCatalogService | undefined } = { current: undefined };
  registerMinorModeCommand(pi, () => activeCatalog.current);
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin((cordis: Context) => {
    modeCatalogPlugin(cordis, pi, activeCatalog);
  });
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

function modeCatalogPlugin(
  cordis: Context,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  activeCatalog: { current: MinorModeCatalogService | undefined },
): void {
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
    const sessionKind = context.hasUI && context.mode === 'tui' ? 'tui' : 'headless';
    const catalog: MinorModeCatalogHost = createMinorModeCatalogHost({
      sessionKind,
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
    activeCatalog.current = catalog;

    // Journal the projection so RPC clients see catalog state live and on
    // replay; identical projections are skipped so detail churn stays cheap.
    let published: string | undefined;
    let settle: NodeJS.Timeout | undefined;
    const publish = (): void => {
      settle = undefined;
      const projection = projectMinorModes(catalog.getSnapshot(), sessionKind);
      const serialized = JSON.stringify(projection);
      if (serialized === published) return;
      published = serialized;
      pi.appendEntry(DOOM_MINOR_MODE_ENTRY_TYPE, projection);
    };
    const unsubscribe = catalog.subscribe(() => {
      settle ??= setTimeout(publish, PROJECTION_SETTLE_MS);
    });

    return () => {
      if (settle) clearTimeout(settle);
      unsubscribe();
      activeCatalog.current = undefined;
      catalog.dispose();
    };
  });
}

export default modeCatalogExtension;
