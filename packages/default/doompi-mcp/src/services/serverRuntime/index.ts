import type {
  DoomHeadlessActivity,
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';

import { COMMAND_NAME, SERVER_COMMAND_DESCRIPTION } from '../../constants/mcp';
import { MCP_STATUS_KEY } from '../../constants/piMcp';
import { McpHeadlessToolParameters } from '../../schemas/mcpHeadlessTool';
import { formatMcpSessionAuthStatus, MCP_SESSION_AUTH_STATUS_KEY } from '../../types/webMcp';
import { formatStatus } from '../mcpCommand';
import { McpSession } from '../mcpSession';
import { createMcpChildTool } from '../mcpSessionTools';
import { readSessionConfig } from '../sessionConfig';

export function createMcpServerRuntime(environment: Readonly<Record<string, string | undefined>> = {}) {
  let active: DoomHeadlessExecutionContext | undefined;
  const authorizing = new Map<string, symbol>();
  const session = new McpSession({
    environment: { ...environment },
    onAuthorizationUrl: async (url, serverName) => {
      await active?.client.notify({
        title: `Authorize MCP server ${serverName}`,
        body: url.toString(),
        level: 'warning',
      });
    },
  });

  const activity: DoomHeadlessActivity = {
    name: 'doompi-mcp-runtime',
    async start(execution) {
      active = execution;
      const reported = new Set<string>();
      const publish = () => {
        execution.client.setStatus(
          MCP_STATUS_KEY,
          session
            .getServers()
            .map((server) => server.name)
            .join(','),
        );
        execution.client.setStatus(MCP_SESSION_AUTH_STATUS_KEY, formatMcpSessionAuthStatus(session.getServers()));
        for (const diagnostic of session.getDiagnostics()) {
          if (reported.has(diagnostic)) continue;
          reported.add(diagnostic);
          void execution.client.notify({ title: 'DoomPi MCP', body: diagnostic, level: 'warning' });
        }
      };
      const stopPublishing = session.onChange(publish);
      try {
        await session.reconfigure(readSessionConfig(execution.environment, execution.cwd));
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
        authorizing.clear();
        try {
          await session.dispose();
        } finally {
          // Withdraw tools and UI state even when a connection fails to close.
          session.install({ enabled: false, repoRoot: execution.cwd, stagingDirectory: execution.cwd });
          execution.client.setStatus(MCP_STATUS_KEY, undefined);
          execution.client.setStatus(MCP_SESSION_AUTH_STATUS_KEY, undefined);
        }
      };
    },
  };

  const invoke: Parameters<typeof createMcpChildTool>[0] = async (parameters, signal) => {
    if (!active) throw new Error('The MCP runtime has not started yet.');
    const selected = session
      .activeToolDefinitions()
      .find((candidate) => candidate.serverName === parameters.server && candidate.toolName === parameters.tool);
    if (!selected)
      throw new Error(`MCP tool ${parameters.server}/${parameters.tool} is not available in this session.`);
    return session.invokeTool(selected.piName, parameters.arguments ?? {}, signal);
  };
  const childTool = createMcpChildTool(invoke);

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
            await session.openAuthorizationPage(serverName);
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
          authorizing.clear();
          try {
            await session.dispose();
          } finally {
            // Reset the catalog even when paths are unchanged or teardown fails.
            session.install({ enabled: false, repoRoot: execution.cwd, stagingDirectory: execution.cwd });
          }
          await session.reconfigure(readSessionConfig(execution.environment, execution.cwd));
          await notify('Reconnecting MCP servers.');
          return;
        }
        throw new Error(`Unknown /${COMMAND_NAME} subcommand "${subcommand}". Use status, auth, disconnect, reload.`);
      } catch (error) {
        await notify(error instanceof Error ? error.message : String(error), 'warning');
      }
    },
  };
  return { session, activities: [activity], commands: [command], tools: [tool], childTool };
}
