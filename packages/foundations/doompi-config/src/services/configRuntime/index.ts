import { DOOM_CORDIS_SESSION_SERVICE, type DoomCordisSessionService } from '@agimon-ai/doompi-core/cordis-host';
import {
  createDisabledDoomMcpProjection,
  createDoomMcpProjectionService,
  DOOM_MCP_PROJECTION_SERVICE,
  isDoomMcpProjection,
} from '@agimon-ai/doompi-core/mcp-projection';
import { type DoomNotificationLevel, readDoomNotificationService } from '@agimon-ai/doompi-core/notification';
import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_SERVICE,
  type DoomReadinessHandle,
  type DoomReadinessNotification,
} from '@agimon-ai/doompi-core/readiness';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { PACKAGE_SOURCE } from '../../constants/config';
import { getHarnessState } from '../harnessStore';
import {
  acknowledgeDoomConfigTransition,
  createDoomConfigContextAsync,
  provideDoomConfigContext,
} from '../sessionConfig';
import type { ConfigRuntime } from './type';

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
  if (context.hasUI) context.ui.notify(body, level);
  else process.emitWarning(body);
}

interface ConfigInitialization {
  readonly token: symbol;
  readonly sessionManager: ExtensionContext['sessionManager'];
  readonly handle: DoomReadinessHandle<void>;
}

export function createConfigRuntime(pi: ExtensionAPI): ConfigRuntime {
  let initialization: ConfigInitialization | undefined;
  let sessionInjection: ReturnType<Context['inject']> | undefined;
  return {
    plugin(cordis) {
      sessionInjection = cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
        const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
        const context = session.context;
        const token = Symbol(session.generation);
        let active = true;
        let initializationTask: Promise<void> = Promise.resolve();
        let telemetry: DoomTelemetry | undefined;
        const readiness = createDoomReadinessCoordinator({
          notify(notification: DoomReadinessNotification) {
            const diagnostics = notification.diagnostics.join('; ');
            const detail = (notification.error?.message ?? diagnostics) || 'Initialization did not complete.';
            const message = `${notification.packageId} initialization ${notification.state}: ${detail}`;
            notify(sessionContext, context, message, 'warning');
          },
        });
        sessionContext.effect(
          () => async () => {
            active = false;
            if (initialization?.token === token) initialization = undefined;
            await Promise.allSettled([readiness.dispose(), initializationTask]);
            await telemetry?.shutdown();
          },
          `${PACKAGE_SOURCE}/session`,
        );

        // Consumers can resolve and register their own work as soon as the host's
        // session fiber activates. Config file I/O continues behind the barrier
        // below so Cordis activation itself stays synchronous.
        sessionContext.provide(DOOM_READINESS_SERVICE, readiness);
        const sessionTelemetry = createDoomTelemetry({
          serviceName: 'doom-config',
          packageName: PACKAGE_SOURCE,
          cwd: context.cwd,
          env: process.env,
          enableLogs: true,
          enableTraces: true,
        });
        telemetry = sessionTelemetry;
        const handle = readiness.start<void>(PACKAGE_SOURCE, session.generation, async (signal) => {
          acknowledgeDoomConfigTransition(pi, context, getHarnessState());
          const config = await createDoomConfigContextAsync(context);
          if (signal.aborted) throw signal.reason;
          if (!active || initialization?.token !== token) {
            throw new Error(`Doom Config initialization was superseded: ${session.generation}.`);
          }

          provideDoomConfigContext(sessionContext, config, `${session.generation}:config`);
          const repoRoot = config.harness.root ?? context.cwd;
          const stagingDirectory = config.harness.temporaryDirectory ?? context.cwd;
          const projection =
            config.harness.mcp &&
            isDoomMcpProjection(config.harness.mcpProjection) &&
            config.harness.mcpProjection.repoRoot === repoRoot
              ? config.harness.mcpProjection
              : createDisabledDoomMcpProjection({ repoRoot, stagingDirectory });
          sessionContext.provide(
            DOOM_MCP_PROJECTION_SERVICE,
            createDoomMcpProjectionService({
              sessionId: session.sessionId,
              generation: `${session.generation}:mcp-projection`,
              projection,
            }),
          );
          void Promise.allSettled([
            sessionTelemetry.recordEvent('doom_config.context_bound', {
              'config.major_mode': config.harness.majorMode,
              'config.domain_count': config.harness.domains.length,
              'config.has_profile': config.harness.profile !== undefined,
              'config.requires_relaunch': config.requiresRelaunch,
            }),
          ]);
          return { value: undefined };
        });
        initialization = { token, sessionManager: context.sessionManager, handle };
        initializationTask = handle.wait();
        // The Pi barrier observes this same promise. Attaching a rejection handler
        // now also covers hosts that dispose before Pi reaches that handler.
        void Promise.allSettled([initializationTask]);
      });
    },
    // The host publishes its session before this barrier allows later features to start.
    async onSessionStart(_event, context) {
      await sessionInjection?.await();
      const current = initialization;
      if (!current || current.sessionManager !== context.sessionManager) {
        throw new Error('Doom Config initialization is unavailable for the active session.');
      }
      await current.handle.wait();
      if (initialization?.token !== current.token) {
        throw new Error('Doom Config initialization was superseded before the session barrier completed.');
      }
    },
  };
}
