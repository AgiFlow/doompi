import type { DoomCordisRuntimeService } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import { DOOM_MCP_STATUS_SERVICE, type DoomMcpStatusService } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import {
  DOOM_MCP_TOOL_RESOLVER_SERVICE,
  type DoomMcpToolResolverService,
} from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';
import {
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_MCP_PROJECTION_SERVICE,
  readDoomMcpProjectionService,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import { DOOM_TOOL_SURFACE_SERVICE, requireDoomToolSurface } from '@agimon-ai/doompi-extension-contracts/tool-surface';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import type { McpSessionConfig } from '../types/mcpConfig';
import { formatMcpSessionAuthStatus, MCP_SESSION_AUTH_STATUS_KEY } from '../types/webMcp';
import { mcpSessionConfigFromProjection } from '../services/projection';
import { readSessionConfig } from '../services/sessionConfig';
import { registerLeaderContribution } from './leader';
import { MCP_STATUS_KEY } from '../constants/piMcp';
import { McpSession } from '../services/mcpSession';

const INFO = 'info';
const WARNING = 'warning';

function failClosedSessionConfig(cwd: string): McpSessionConfig {
  return {
    enabled: false,
    repoRoot: cwd,
    stagingDirectory: path.join(cwd, '.doom', 'mcp-disabled'),
    sources: [],
  };
}

export function createMcpPiRuntime(runtime: DoomCordisRuntimeService) {
  const mode = runtime.mode;
  let activeContext: ExtensionContext | undefined;
  let disposed = false;
  const session = new McpSession({
    onAuthorizationUrl: async (url, serverName, { openBrowser }) => {
      const context = activeContext;
      if (context?.mode === 'tui') {
        if (!openBrowser) return;
        try {
          const { default: open } = await import('open');
          await open(url.toString());
        } catch (error) {
          context.ui.notify(
            `Could not open the authorization page for ${serverName}: ${error instanceof Error ? error.message : String(error)}. Press a in the MCP overlay to retry.`,
            WARNING,
          );
          throw error;
        }
        return;
      }
      context?.ui?.notify(`Authorize ${serverName} by opening:\n${url.toString()}`, INFO);
    },
  });

  return {
    session,
    services: [
      (cordis: Context) => {
        cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => registerLeaderContribution(requireDoomUiHub(uiContext)));
        // The surface lives on the session fiber, so this resolves after install has
        // already registered the cached wrappers: binding is what first hides the ones
        // no server has confirmed.
        cordis.inject([DOOM_TOOL_SURFACE_SERVICE], (surfaceContext) =>
          session.bindToolSurface(requireDoomToolSurface(surfaceContext)),
        );
        cordis.inject([DOOM_CORDIS_SESSION_SERVICE], async (sessionContext) => {
          const hostSession = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
          const context = hostSession.context;
          const expectedSessionId = hostSession.sessionId;
          let sessionActive = true;
          activeContext = context;
          // The legacy server-name status remains available to every UI. The compact
          // authorization status is browser-only so the TUI footer stays unchanged.
          const publishServerStatus = (): void => {
            const servers = session.getSnapshot().servers;
            const names = servers.map((server) => server.name).join(',');
            context.ui?.setStatus(MCP_STATUS_KEY, names);
            if (context.mode !== 'tui') {
              context.ui?.setStatus(MCP_SESSION_AUTH_STATUS_KEY, formatMcpSessionAuthStatus(session.getServers()));
            }
          };
          const stopPublishing = session.onChange(publishServerStatus);
          publishServerStatus();

          if (mode === 'standalone') {
            await session.reconfigure(readSessionConfig(process.env, context.cwd));
          } else {
            await session.reconfigure(failClosedSessionConfig(context.cwd));
            sessionContext.inject([DOOM_MCP_PROJECTION_SERVICE], async (projectionContext) => {
              const projection = readDoomMcpProjectionService(projectionContext);
              if (!projection || projection.sessionId !== expectedSessionId) {
                await session.reconfigure(failClosedSessionConfig(context.cwd));
                if (projection && sessionActive && !disposed) {
                  context.ui?.notify(
                    `The Doom MCP projection belongs to session "${projection.sessionId}", not "${expectedSessionId}"; MCP is disabled.`,
                    WARNING,
                  );
                }
              } else {
                await session.reconfigure(mcpSessionConfigFromProjection(projection.getSnapshot()));
              }
              return async () => {
                if (sessionActive && !disposed) await session.reconfigure(failClosedSessionConfig(context.cwd));
              };
            });
          }

          const status: DoomMcpStatusService = Object.freeze({
            generation: `${hostSession.generation}:mcp-status`,
            getSnapshot: () => session.getSnapshot(),
            onChange: (listener: () => void) => session.onChange(listener),
          });
          const toolResolver: DoomMcpToolResolverService = Object.freeze({
            generation: `${hostSession.generation}:mcp-tool-resolver`,
            resolve: (selectors: readonly string[]) => session.resolveToolSelectors(selectors),
          });
          sessionContext.provide(DOOM_MCP_STATUS_SERVICE, status);
          sessionContext.provide(DOOM_MCP_TOOL_RESOLVER_SERVICE, toolResolver);
          for (const diagnostic of session.getDiagnostics()) context.ui?.notify(diagnostic, WARNING);
          return async () => {
            sessionActive = false;
            stopPublishing();
            context.ui?.setStatus(MCP_STATUS_KEY, undefined);
            if (context.mode !== 'tui') context.ui?.setStatus(MCP_SESSION_AUTH_STATUS_KEY, undefined);
            if (activeContext === context) activeContext = undefined;
            if (!disposed) await session.reconfigure(failClosedSessionConfig(context.cwd));
          };
        });
      },
    ],
    async onDispose() {
      disposed = true;
      activeContext = undefined;
      await session.dispose();
    },
  };
}
