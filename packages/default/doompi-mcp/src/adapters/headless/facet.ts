import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessContent,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { COMMAND_NAME } from '../../schemas/mcpCommands.ts';
import { McpHeadlessToolParameters } from '../../schemas/mcpHeadlessTool.ts';
import { buildMcpConfigGroups } from '../node/configSources.ts';
import { McpRuntimeOwner } from '../node/mcpRuntime.ts';
import { readSessionConfig } from '../process/sessionConfig.ts';

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function resultContent(result: unknown): DoomHeadlessContent[] {
  const content = record(result).content;
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(result) }];
  return content.map((block): DoomHeadlessContent => {
    const item = record(block);
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text };
    if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      return { type: 'image', data: item.data, mimeType: item.mimeType };
    }
    return { type: 'text', text: JSON.stringify(block) };
  });
}

function readConfig(environment: Readonly<Record<string, string | undefined>>, cwd: string): string {
  const config = readSessionConfig(environment, cwd);
  const groups = buildMcpConfigGroups(config);
  return JSON.stringify(
    {
      enabled: config.enabled !== false,
      repoRoot: config.repoRoot,
      shared: groups.shared.configPaths,
      sessionLocal: groups.sessionLocal.configPaths,
      droppedServers: groups.droppedServers,
      diagnostics: groups.diagnostics,
    },
    null,
    2,
  );
}

export const mcpHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    let runtime: McpRuntimeOwner | undefined;
    const resource: DoomHeadlessResource = {
      name: 'doompi/mcp-config',
      kind: 'context',
      read: (execution) => readConfig(execution.environment, execution.cwd),
    };
    const activity: DoomHeadlessActivity = {
      name: 'doompi-mcp-runtime',
      async start(execution) {
        const owner = new McpRuntimeOwner();
        runtime = owner;
        try {
          const config = readSessionConfig(execution.environment, execution.cwd);
          const groups = buildMcpConfigGroups(config);
          const sources = [...groups.shared.configSources, ...groups.sessionLocal.configSources];
          await owner.start({
            configSources: sources,
            onAuthorizationUrl: (url, serverName) =>
              void execution.client.notify({
                title: `Authorize MCP server ${serverName}`,
                body: url.toString(),
                level: 'warning',
              }),
            onServerStateChange: (change) => {
              execution.client.setStatus('doompi-mcp', `${change.serverName}: ${change.state}`);
            },
          });
        } catch (error) {
          await execution.client.notify({
            title: 'DoomPi MCP unavailable',
            body: error instanceof Error ? error.message : String(error),
            level: 'warning',
          });
        }
        return async () => {
          if (runtime !== owner) return;
          runtime = undefined;
          await owner.dispose();
          execution.client.setStatus('doompi-mcp', undefined);
        };
      },
    };
    // web-plugin-tool-renderers: ignore mcp_use, headless-only generic MCP dispatch
    const tool: DoomHeadlessTool<typeof McpHeadlessToolParameters> = {
      name: 'mcp_use',
      label: 'MCP use',
      description: 'Call a tool exposed by a connected MCP server.',
      parameters: McpHeadlessToolParameters,
      executionMode: 'serial',
      async execute(_toolCallId, parameters) {
        const services = runtime?.getServices();
        if (!services) {
          return { content: [{ type: 'text', text: 'The MCP runtime has not started yet.' }], isError: true };
        }
        try {
          const connection = await services.clientManager.ensureConnected(parameters.server);
          const result = await connection.callTool(parameters.tool, parameters.arguments ?? {});
          return {
            content: resultContent(result),
            details: result,
            ...(record(result).isError === true ? { isError: true } : {}),
          };
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
      description: 'Show MCP configuration or begin an authorization request.',
      async execute(args, execution) {
        const [subcommand = 'status', serverName] = args.trim().split(/\s+/u).filter(Boolean);
        if (subcommand === 'auth') {
          const result = await execution.client.request({
            kind: 'input',
            title: `Authorize MCP server${serverName ? ` ${serverName}` : ''}`,
            message: 'Paste the authorization URL or code supplied by the MCP server.',
          });
          if (typeof result === 'string' && result.trim()) {
            await execution.client.notify({
              body: `MCP authorization received for ${serverName ?? 'server'}.`,
              level: 'info',
            });
          }
          return;
        }
        await execution.client.notify({
          title: 'DoomPi MCP',
          body: readConfig(execution.environment, execution.cwd),
          level: subcommand === 'status' ? 'info' : 'warning',
        });
      },
    };
    const registrations = [
      host.registerResource(resource),
      host.registerActivity(activity),
      host.registerTool(tool),
      host.registerCommand(command),
    ];
    return () => {
      for (const registration of registrations.reverse()) registration.dispose();
    };
  },
};
