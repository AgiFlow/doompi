import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordis-host';
import { type DoomNotificationLevel, readDoomNotificationService } from '@agimon-ai/doompi-core/notification';
import type { PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import {
  DOOM_TRANSITION_SERVICE,
  requireDoomTransitionCoordinator,
  type TransitionSource,
} from '@agimon-ai/doompi-core/transition';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  DOOM_MINOR_MODE_ENTRY_TYPE,
  type MinorModeActionResponse,
  type MinorModeCatalogService,
} from '../schemas/mode';
import { createMinorModeCatalogHost } from '../services/catalog';
import { projectMinorModes } from '../services/projection';
import { consumeMinorModeReloadHandoff, discardMinorModeReloadHandoff } from '../services/reloadHandoff';
import { registerMinorModeCommand } from './minorModeCommand';

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
  /**
   * The bound session, which the detail store is keyed by.
   *
   * The server launches the agent with `--session-id`, so this is the same id
   * the cockpit and the session API know the session by, and a browser asking
   * for a row's detail looks under the file this session wrote.
   */
  sessionId?: string;
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

/**
 * The minor modes that are actually on, for the composition panel.
 *
 * Read from the bound catalog at publish time rather than passed in, because a
 * mode switching on is one of the reasons a publish happens at all, and a
 * remembered list would describe the composition before the switch.
 */
export function createMinorModePiRuntime(pi: ExtensionAPI): PiPluginContributions {
  // The command outlives any one session: it is registered once and reads the
  // catalog binding the session-scoped inject below sets and clears.
  const activeCatalog: CatalogBinding = { current: undefined };
  registerMinorModeCommand(pi, () => activeCatalog.current);
  // The composition is only complete once every extension has registered, so
  // the inventory is read on the same deferred tick the catalog republishes on.
  pi.on('session_start', () => {
    setTimeout(() => {
      activeCatalog.republish?.();
    }, BOOT_PUBLISH_DELAY_MS);
  });
  return { services: [(cordis: Context) => modeCatalogPlugin(cordis, pi, activeCatalog)] };
}

function modeCatalogPlugin(
  cordis: Context,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  activeCatalog: CatalogBinding,
): void {
  cordis.inject([DOOM_CORDIS_SESSION_SERVICE, DOOM_TRANSITION_SERVICE], (sessionContext) => {
    const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
    const context = session.context;
    const coordinator = requireDoomTransitionCoordinator(sessionContext);
    const reloadSession = session.reason === 'reload';
    const sessionId = session.sessionId;
    const restoreSnapshot = reloadSession ? consumeMinorModeReloadHandoff(sessionId) : undefined;
    if (!reloadSession) discardMinorModeReloadHandoff(sessionId);
    const sessionKind = context.hasUI && context.mode === 'tui' ? 'tui' : 'headless';
    const catalog: MinorModeCatalogService = createMinorModeCatalogHost({
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
            target: { axis: 'live', capability: 'minor-mode' },
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
    activeCatalog.sessionId = sessionId;

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
      activeCatalog.sessionId = undefined;
      catalog.dispose();
    };
  });
}
