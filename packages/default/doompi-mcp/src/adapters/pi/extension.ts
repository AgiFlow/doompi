import { DOOM_MCP_STATUS_SERVICE, type DoomMcpStatusService } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import {
  DOOM_MCP_TOOL_RESOLVER_SERVICE,
  type DoomMcpToolResolverService,
} from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';
import {
  connectDoomCordisHost,
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisHostMode,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import {
  DOOM_MCP_PROJECTION_SERVICE,
  readDoomMcpProjectionService,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { registerCommand } from '../../commands/mcpCommand.ts';
import type { McpSessionConfig } from '../../types/mcpConfig.ts';
import { formatMcpSessionAuthStatus, MCP_SESSION_AUTH_STATUS_KEY } from '../../types/webMcp.ts';
import { mcpSessionConfigFromProjection } from '../node/projection.ts';
import { readSessionConfig } from '../process/sessionConfig.ts';
import { registerLeaderContribution } from './leader.ts';
import { MCP_STATUS_KEY, PACKAGE_SOURCE } from './mcpConstants.ts';
import { McpSession } from './mcpSession.ts';

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

/**
 * MCP support for a Pi session.
 *
 * Tools are registered synchronously from the previous catalog. Connecting
 * starts on `session_start`, so a slow server never blocks extension loading.
 */
export async function registerMcpExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(mcpPlugin, { pi, mode: connection.runtime.mode });
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

interface McpPluginOptions {
  readonly pi: ExtensionAPI;
  readonly mode: DoomCordisHostMode;
}

function mcpPlugin(cordis: Context, { pi, mode }: McpPluginOptions): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-mcp',
          description:
            'Use Doom Pi MCP to inspect domain-scoped servers, authenticate, reload configuration, and troubleshoot tool availability.',
        },
      ],
    });
    return () => contribution.dispose();
  });

  let activeContext: ExtensionContext | undefined;
  let disposed = false;
  const session = new McpSession({
    pi,
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

  registerCommand(pi, session, {
    openOverlay: async (ctx) => {
      const { openMcpOverlay } = await import('../../tui/mcpOverlay.ts');
      return openMcpOverlay(ctx, session);
    },
  });
  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => registerLeaderContribution(requireDoomUiHub(uiContext)));
  cordis.effect(
    () => async () => {
      disposed = true;
      activeContext = undefined;
      await session.dispose();
    },
    PACKAGE_SOURCE,
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
}
