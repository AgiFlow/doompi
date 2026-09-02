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
import {
  type DoomNotificationLevel,
  readDoomNotificationService,
} from '@agimon-ai/doompi-extension-contracts/notification';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  consumeMinorModeReloadHandoff,
  discardMinorModeReloadHandoff,
  type MinorModeCatalogHost,
  DOOM_TRANSITION_SERVICE,
  requireDoomTransitionCoordinator,
  type TransitionSource,
} from '@agimon-ai/doompi-extension-contracts/transition';
import type { Context } from '@deepseek-ai/cordis';
import { type ContextPublisher, createContextPublisher } from '../../services/contextCatalog.ts';
import { projectMinorModes } from '../../services/minorModeProjection.ts';
import { createMinorModeCatalogHost } from '../../services/modeCatalog.ts';
import { registerMinorModeCommand } from './minorModeCommand.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi/mode-catalog';
const HELP_CONTRIBUTION_SOURCE = '@agimon-ai/doompi';
/** Registrations and state flips arrive in bursts; one entry covers a burst. */
const PROJECTION_SETTLE_MS = 50;
/**
 * Pi's rpc mode subscribes to session events only after bindExtensions()
 * returns, which is after session_start has run, so an entry journaled during
 * startup never reaches a client. A publish deferred past that point does.
 */
const BOOT_PUBLISH_DELAY_MS = 500;

interface CatalogBinding {
  current: MinorModeCatalogService | undefined;
  /** Journals the projection even if unchanged; set while a session is bound. */
  republish?: () => void;
}

function notify(cordis: Context, context: ExtensionContext, body: string, level: DoomNotificationLevel): void {
  const service = readDoomNotificationService(cordis);
  if (service) {
    try {
      void Promise.resolve(service.request({ body, level })).catch(() => undefined);
    } catch {
      // Notification delivery is best effort and does not fall back after routing.
    }
    return;
  }
  context.ui.notify(body, level);
}

function transitionSource(requesterSource: string): TransitionSource {
  if (requesterSource.includes('voice')) return 'voice';
  if (requesterSource.includes('leader')) return 'leader';
  if (requesterSource.includes('ui')) return 'ui';
  return 'system';
}

export async function modeCatalogExtension(pi: ExtensionAPI): Promise<void> {
  // The command outlives any one session: it is registered once and reads the
  // catalog binding the session-scoped inject below sets and clears.
  const activeCatalog: CatalogBinding = { current: undefined };
  registerMinorModeCommand(pi, () => activeCatalog.current);
  // The composition is only complete once every extension has registered, so
  // the inventory is read on the same deferred tick the catalog republishes on.
  const contextBinding: { publisher?: ContextPublisher } = {};
  pi.on('session_start', () => {
    setTimeout(() => {
      activeCatalog.republish?.();
      void contextBinding.publisher?.publish();
    }, BOOT_PUBLISH_DELAY_MS);
  });
  // MCP status is pull-only and servers connect long after startup, so the
  // boot read above cannot see them. A turn is the moment the composition is
  // actually sent, which makes it both the freshest and the most meaningful
  // time to price. Identical compositions are skipped, so a quiet session
  // journals nothing extra.
  pi.on('turn_start', () => {
    void contextBinding.publisher?.publish();
  });
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin((cordis: Context) => {
    contextBinding.publisher = createContextPublisher(pi, cordis);
    modeCatalogPlugin(cordis, pi, activeCatalog, () => void contextBinding.publisher?.publish());
    return () => {
      contextBinding.publisher?.dispose();
      contextBinding.publisher = undefined;
    };
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
  activeCatalog: CatalogBinding,
  onCatalogChanged: () => void,
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
        notify(
          sessionContext,
          context,
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
      // A mode changing is the usual reason the toolbox changed too.
      onCatalogChanged();
    };
    const unsubscribe = catalog.subscribe(() => {
      settle ??= setTimeout(publish, PROJECTION_SETTLE_MS);
    });
    activeCatalog.republish = () => {
      published = undefined;
      publish();
    };

    return () => {
      if (settle) clearTimeout(settle);
      unsubscribe();
      activeCatalog.republish = undefined;
      activeCatalog.current = undefined;
      catalog.dispose();
    };
  });
}

export default modeCatalogExtension;
