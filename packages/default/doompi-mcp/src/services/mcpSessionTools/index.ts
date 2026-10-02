import type { DoomChildSessionMcpCatalog, DoomChildSessionMcpTool } from '@agimon-ai/doompi-core/childSession';
import type { DoomHeadlessTool, DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { McpHeadlessToolParameters } from '../../schemas/mcpHeadlessTool';
import type { CatalogTool } from '../mcpCatalog';
import type { McpSession } from '../mcpSession';

export const MCP_SESSION_TOOLS_SERVICE = 'doom/mcp-session-tools';

/** This projection needs no caller-owned execution context and can be borrowed unchanged. */
export interface McpDirectTool extends DoomHeadlessTool {
  execute(toolCallId: string, parameters: unknown, signal?: AbortSignal): Promise<DoomHeadlessToolResult>;
}

/** Narrow cross-root access to the Pi session's existing upstream MCP runtime. */
export interface McpSessionToolsService {
  readonly generation: string;
  snapshot(): readonly CatalogTool[];
  project(): readonly McpDirectTool[];
  refresh(): void;
  dispose(): void;
  resolveSelectors(selectors: readonly string[]): readonly string[];
  onChange(listener: () => void): () => void;
  invoke(name: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<DoomHeadlessToolResult>;
}

export function createMcpSessionToolsService(
  session: McpSession,
  generation: string,
  assertAvailable: () => void = () => undefined,
): McpSessionToolsService {
  let disposed = false;
  const listeners = new Set<() => void>();
  const retained = new Map<string, { fingerprint: string; tool: McpDirectTool; retire(): void }>();
  const snapshot = () => {
    try {
      if (disposed) return [];
      assertAvailable();
      return session.activeToolDefinitions();
    } catch {
      // An inactive or stale parent lends no declarations.
      return [];
    }
  };
  const project = (): readonly McpDirectTool[] => {
    const definitions = snapshot();
    const names = new Set(definitions.map((tool) => tool.piName));
    for (const [name, entry] of retained) {
      if (names.has(name)) continue;
      entry.retire();
      retained.delete(name);
    }
    return definitions.map((definition) => {
      const fingerprint = JSON.stringify([session.toolGeneration, definition]);
      const previous = retained.get(definition.piName);
      if (previous?.fingerprint === fingerprint) return previous.tool;
      previous?.retire();
      let retired = false;
      const invoke = session.bindToolInvocation(definition);
      const tool: McpDirectTool = {
        name: definition.piName,
        label: `${definition.serverName}: ${definition.toolName}`,
        description: definition.description ?? `${definition.toolName} on the ${definition.serverName} MCP server.`,
        ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
        ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
        parameters: (Object.keys(definition.inputSchema).length > 0
          ? definition.inputSchema
          : { type: 'object', properties: {} }) as TSchema,
        async execute(_toolCallId, parameters, signal) {
          assertAvailable();
          if (retired) throw new Error(`MCP tool ${definition.piName} is no longer available.`);
          signal?.throwIfAborted();
          const arguments_ = parameters === undefined ? {} : parameters;
          if (!Value.Check(tool.parameters, arguments_))
            throw new Error(`Invalid arguments for MCP tool ${definition.piName}.`);
          const result = await invoke(arguments_ as Record<string, unknown>, signal);
          signal?.throwIfAborted();
          return result;
        },
      };
      retained.set(definition.piName, {
        fingerprint,
        tool,
        retire: () => {
          retired = true;
        },
      });
      return tool;
    });
  };
  const refresh = () => {
    project();
    for (const listener of listeners) listener();
  };
  // Retirement must happen even if a borrower temporarily has no change listener.
  const stopSession = session.onChange(refresh);
  return Object.freeze({
    generation,
    snapshot,
    project,
    refresh,
    dispose: () => {
      disposed = true;
      stopSession();
      refresh();
      listeners.clear();
    },
    resolveSelectors: (selectors: readonly string[]) => {
      const active = new Set(snapshot().map((tool) => tool.piName));
      return session
        .resolveToolSelectors(selectors)
        .map((tool) => tool.name)
        .filter((name) => active.has(name));
    },
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invoke: async (name: string, parameters: Record<string, unknown>, signal?: AbortSignal) => {
      assertAvailable();
      const tool = project().find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`MCP tool ${name} is not available in this session.`);
      return tool.execute('mcp', parameters, signal);
    },
  });
}

/** Borrow an existing MCP runtime; a child never starts or disposes its own upstream connections. */
export function createMcpChildTool(
  invoke: (
    parameters: Static<typeof McpHeadlessToolParameters>,
    signal?: AbortSignal,
  ) => Promise<DoomHeadlessToolResult>,
  catalog?: DoomChildSessionMcpCatalog,
): DoomChildSessionMcpTool {
  return {
    name: 'mcp',
    ...(catalog === undefined ? {} : { catalog }),
    description: 'Call a tool exposed by a connected MCP server.',
    parameters: McpHeadlessToolParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      if (!Value.Check(McpHeadlessToolParameters, parameters)) throw new Error('Invalid MCP tool arguments.');
      const result = await invoke(parameters, signal);
      signal?.throwIfAborted();
      return result;
    },
  };
}
