import path from 'node:path';

import { loadHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { CONTEXT_TOOL_WARNINGS_STATUS_KEY } from '@agimon-ai/doompi-core/contextApi';
import type {
  DoomHeadlessActivity,
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessSelection,
  DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { isDoomMcpProjection, type DoomMcpProjectionResolverService } from '@agimon-ai/doompi-core/mcpProjection';
import type { DoomMcpSessionConfig } from '@agimon-ai/doompi-core/mcpSession';

import { COMMAND_NAME, SERVER_COMMAND_DESCRIPTION } from '../../constants/mcp';
import { MCP_STATUS_KEY } from '../../constants/piMcp';
import { McpHeadlessToolParameters } from '../../schemas/mcpHeadlessTool';
import { formatMcpSessionAuthStatus, MCP_SESSION_AUTH_STATUS_KEY } from '../../types/webMcp';
import { formatStatus } from '../mcpCommand';
import { McpSession } from '../mcpSession';
import { createMcpSessionApi } from '../mcpSessionApi';
import { createMcpChildTool, createMcpSessionToolsService } from '../mcpSessionTools';
import { type CountTokens, mcpToolTokens } from '../mcpToolCost';
import { mcpSessionConfigFromProjection } from '../projection';
import { readSessionConfig } from '../sessionConfig';

function sessionConfiguration(execution: DoomHeadlessExecutionContext, workspaceRoot?: string): DoomMcpSessionConfig {
  if (workspaceRoot !== undefined) {
    const loaded = loadHarnessState({ ...execution.environment });
    const projection = loaded.state.mcpProjection;
    if (
      loaded.filePath &&
      loaded.state.root === workspaceRoot &&
      execution.repoRoot === workspaceRoot &&
      loaded.state.mcp &&
      loaded.state.majorMode === execution.selection.majorMode &&
      JSON.stringify(loaded.state.domains) === JSON.stringify(execution.selection.domains) &&
      JSON.stringify(loaded.state.layers) === JSON.stringify(execution.selection.activeLayers) &&
      isDoomMcpProjection(projection) &&
      projection.repoRoot === workspaceRoot
    )
      return mcpSessionConfigFromProjection(projection, execution.cwd);
    return {
      enabled: false,
      repoRoot: execution.cwd,
      stagingDirectory: path.join(execution.cwd, '.doom', 'mcp-disabled'),
      sources: [],
    };
  }
  return readSessionConfig(execution.environment, execution.cwd);
}

export function createMcpServerRuntime(
  environment: Readonly<Record<string, string | undefined>> = {},
  workspaceRoot?: string,
  getResolver?: () => DoomMcpProjectionResolverService | undefined,
) {
  let active: DoomHeadlessExecutionContext | undefined;
  let currentSelection: DoomHeadlessSelection | undefined;
  let staleSelection = false;
  let cleanup: (() => Promise<void>) | undefined;
  let transition = Promise.resolve();
  const authorizing = new Map<string, symbol>();
  // Authorization URLs reach clients through the MCP status snapshot, not the transcript.
  const session = new McpSession({ environment: { ...environment } });
  const assertAvailable = () => {
    if (!active) throw new Error('The MCP runtime has not started yet.');
    if (staleSelection) throw new Error('The MCP projection is stale for the current selection.');
  };
  const sessionTools = createMcpSessionToolsService(session, crypto.randomUUID(), assertAvailable);

  const refresh = (execution: DoomHeadlessExecutionContext, selection: DoomHeadlessSelection) => {
    staleSelection = true;
    sessionTools.refresh();
    authorizing.clear();
    transition = transition
      .catch(() => {})
      .then(async () => {
        if (active !== execution) return;
        const previousCleanup = cleanup;
        cleanup = undefined;
        try {
          await session.dispose();
        } finally {
          session.install({ enabled: false, repoRoot: execution.cwd, stagingDirectory: execution.cwd });
          await previousCleanup?.();
        }
        if (active !== execution) return;
        const resolver = getResolver?.();
        const loaded = workspaceRoot ? loadHarnessState({ ...execution.environment }) : undefined;
        const authorized =
          workspaceRoot &&
          loaded?.filePath &&
          loaded.state.root === workspaceRoot &&
          execution.repoRoot === workspaceRoot &&
          loaded.state.mcp &&
          isDoomMcpProjection(loaded.state.mcpProjection) &&
          loaded.state.mcpProjection.repoRoot === workspaceRoot &&
          loaded.state.mcpProjection.enabled;
        if (!resolver || !authorized) {
          // A missing or disabled saved projection never grants implicit repository access.
          if (active === execution && selection === currentSelection) {
            if (
              workspaceRoot === undefined ||
              JSON.stringify(execution.selection.domains) === JSON.stringify(selection.domains)
            ) {
              await session.reconfigure(
                sessionConfiguration(execution, workspaceRoot),
                execution.cwd,
                execution.repoRoot,
              );
            }
            staleSelection =
              workspaceRoot !== undefined &&
              JSON.stringify(execution.selection.domains) !== JSON.stringify(selection.domains);
          }
          return;
        }
        const candidate = await resolver.resolve(selection.domains);
        if (active !== execution || selection !== currentSelection) {
          await candidate.cleanup();
          return;
        }
        try {
          if (
            !isDoomMcpProjection(candidate.projection) ||
            candidate.projection.repoRoot !== workspaceRoot ||
            !candidate.projection.enabled
          ) {
            throw new Error('The selected domains returned an invalid MCP projection.');
          }
          await session.reconfigure(
            mcpSessionConfigFromProjection(candidate.projection, execution.cwd),
            execution.cwd,
            execution.repoRoot,
          );
          cleanup = () => candidate.cleanup();
          if (active === execution && selection === currentSelection) staleSelection = false;
        } catch (error) {
          await candidate.cleanup();
          throw error;
        }
      })
      .then(() => sessionTools.refresh())
      .catch(async (error: unknown) => {
        if (active !== execution || selection !== currentSelection) return;
        await execution.client.notify({
          title: 'DoomPi MCP unavailable',
          body: error instanceof Error ? error.message : String(error),
          level: 'warning',
        });
      });
    return transition;
  };

  // The tokenizer loads on first use rather than at startup; the status republishes once it has.
  let countTokens: CountTokens | undefined;
  let tokenizer: Promise<CountTokens> | undefined;
  const loadTokenizer = (): Promise<CountTokens> => {
    tokenizer ??= import('gpt-tokenizer').then((module) => {
      countTokens = module.countTokens;
      return module.countTokens;
    });
    return tokenizer;
  };
  const toolTokens = new Map<string, number>();
  /** Each reachable tool's schema cost, keyed by its registered name, once the tokenizer is loaded. */
  const reachableTokens = (): ReadonlyMap<string, number> => {
    if (countTokens === undefined) return toolTokens;
    for (const tool of session.activeToolDefinitions()) {
      if (!toolTokens.has(tool.piName)) toolTokens.set(tool.piName, mcpToolTokens(tool, countTokens));
    }
    return toolTokens;
  };
  const api = createMcpSessionApi(session, loadTokenizer);

  const activity: DoomHeadlessActivity = {
    name: 'doompi-mcp-runtime',
    async start(execution) {
      active = execution;
      currentSelection = execution.selection;
      staleSelection = false;
      const reported = new Set<string>();
      const publish = () => {
        execution.client.setStatus(
          MCP_STATUS_KEY,
          session
            .getServers()
            .map((server) => server.name)
            .join(','),
        );
        const tokens = reachableTokens();
        execution.client.setStatus(
          MCP_SESSION_AUTH_STATUS_KEY,
          formatMcpSessionAuthStatus(
            session.getServers().map((server) => ({
              ...server,
              tools: server.tools.map((tool) => {
                const cost = tokens.get(tool.piName);
                return cost === undefined ? tool : { ...tool, tokens: cost };
              }),
            })),
          ),
        );
        const warnings = session.getToolWarnings();
        execution.client.setStatus(
          CONTEXT_TOOL_WARNINGS_STATUS_KEY,
          Object.keys(warnings).length === 0 ? undefined : JSON.stringify(warnings),
        );
        for (const diagnostic of session.getDiagnostics()) {
          if (reported.has(diagnostic)) continue;
          reported.add(diagnostic);
          void execution.client.notify({ title: 'DoomPi MCP', body: diagnostic, level: 'warning' });
        }
      };
      const stopPublishing = session.onChange(() => {
        toolTokens.clear();
        publish();
      });
      void loadTokenizer().then(() => {
        if (active === execution) publish();
      });
      try {
        await refresh(execution, execution.selection);
        publish();
      } catch (error) {
        await execution.client.notify({
          title: 'DoomPi MCP unavailable',
          body: error instanceof Error ? error.message : String(error),
          level: 'warning',
        });
      }
      return async () => {
        stopPublishing();
        if (active !== execution) return;
        active = undefined;
        currentSelection = undefined;
        staleSelection = true;
        sessionTools.refresh();
        authorizing.clear();
        await transition;
        const retiredCleanup = cleanup;
        cleanup = undefined;
        try {
          await session.dispose();
        } finally {
          // Withdraw tools and UI state even when a connection fails to close.
          session.install({ enabled: false, repoRoot: execution.cwd, stagingDirectory: execution.cwd });
          await retiredCleanup?.();
          execution.client.setStatus(MCP_STATUS_KEY, undefined);
          execution.client.setStatus(MCP_SESSION_AUTH_STATUS_KEY, undefined);
          execution.client.setStatus(CONTEXT_TOOL_WARNINGS_STATUS_KEY, undefined);
        }
      };
    },
  };

  const invoke: Parameters<typeof createMcpChildTool>[0] = async (parameters, signal) => {
    assertAvailable();
    const selected = sessionTools
      .snapshot()
      .find((candidate) => candidate.serverName === parameters.server && candidate.toolName === parameters.tool);
    if (!selected)
      throw new Error(`MCP tool ${parameters.server}/${parameters.tool} is not available in this session.`);
    return sessionTools.invoke(selected.piName, parameters.arguments ?? {}, signal);
  };
  const childTool = createMcpChildTool(invoke, {
    snapshot: () => sessionTools.project(),
    resolveSelectors: (selectors) => sessionTools.resolveSelectors(selectors),
    subscribe: (listener) => sessionTools.onChange(listener),
  });

  // web-plugin-tool-renderers: ignore mcp_use, headless-only generic MCP dispatch
  const tool: DoomHeadlessTool<typeof McpHeadlessToolParameters> = {
    name: 'mcp_use',
    label: 'MCP use',
    description: 'Call a tool exposed by a connected MCP server.',
    parameters: McpHeadlessToolParameters,
    executionMode: 'serial',
    async execute(_toolCallId, parameters, signal) {
      try {
        return await invoke(parameters, signal);
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  };

  const command: DoomHeadlessCommand = {
    name: COMMAND_NAME,
    description: SERVER_COMMAND_DESCRIPTION,
    async execute(args, execution) {
      const [subcommand = 'status', ...rest] = args.trim().split(/\s+/u).filter(Boolean);
      const serverName = rest.join(' ');
      const notify = (body: string, level: 'info' | 'warning' = 'info') =>
        execution.client.notify({ title: 'DoomPi MCP', body, level });
      try {
        if (subcommand === 'status') {
          await notify(formatStatus(session));
          return;
        }
        if (!active) throw new Error('The MCP runtime has not started yet.');
        if (staleSelection) throw new Error('The MCP projection is stale for the current selection.');
        if (subcommand === 'auth' || subcommand === 'disconnect') {
          if (!serverName) throw new Error(`Name the server, for example /mcp ${subcommand} <server>.`);
          const server = session.getServers().find((candidate) => candidate.name === serverName);
          if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
          if (subcommand === 'disconnect') {
            await session.disconnect(serverName);
            authorizing.delete(serverName);
            await notify(`${serverName} is disconnected from this session. Saved credentials were kept.`);
            return;
          }
          if (server.authorizationUrl) {
            await notify(`${serverName} is waiting for sign-in. Open it from the MCP servers panel.`);
            return;
          }
          if (authorizing.has(serverName)) return;
          const request = Symbol(serverName);
          authorizing.set(serverName, request);
          const owner = active;
          // OAuth waits for the browser. Do not hold the session command queue while it does.
          void session.reauthorize(serverName).then(
            async () => {
              if (active !== owner || authorizing.get(serverName) !== request) return;
              authorizing.delete(serverName);
              await notify(`${serverName} is authorized.`);
            },
            async (error: unknown) => {
              if (active !== owner || authorizing.get(serverName) !== request) return;
              authorizing.delete(serverName);
              await notify(
                `Could not authorize ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
                'warning',
              );
            },
          );
          return;
        }
        if (subcommand === 'reload') {
          if (!currentSelection) throw new Error('The MCP runtime has not started yet.');
          await refresh(active, currentSelection);
          if (!staleSelection) await notify('Reconnecting MCP servers.');
          return;
        }
        throw new Error(`Unknown /${COMMAND_NAME} subcommand "${subcommand}". Use status, auth, disconnect, reload.`);
      } catch (error) {
        await notify(error instanceof Error ? error.message : String(error), 'warning');
      }
    },
  };
  return {
    session,
    sessionTools,
    api: [api],
    activities: [activity],
    commands: [command],
    tools: [tool],
    childTool,
    async onSelectionChange(selection: DoomHeadlessSelection) {
      if (!active || workspaceRoot === undefined) return;
      if (JSON.stringify(currentSelection) === JSON.stringify(selection)) return;
      currentSelection = selection;
      await refresh(active, selection);
    },
  };
}
