import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import type { TSchema } from 'typebox';

import { MCP_SESSION_TOOLS_SERVICE, type McpSessionToolsService } from '../../../../../services/mcpSessionTools';

function fingerprint(service: McpSessionToolsService): string {
  return JSON.stringify(
    service.snapshot().map((tool) => ({
      name: tool.piName,
      description: tool.description,
      schema: tool.inputSchema,
      annotations: tool.annotations,
      outputSchema: tool.outputSchema,
    })),
  );
}

export default defineRoutedContribution(
  (context: DoomMcpPluginContext): readonly DoomHeadlessTool[] => {
    const service = context.services.get<McpSessionToolsService>(MCP_SESSION_TOOLS_SERVICE);
    if (!service) return [];
    let current = fingerprint(service);
    const stop = service.onChange(() => {
      const next = fingerprint(service);
      if (next === current) return;
      current = next;
      context.refresh();
    });
    context.signal.addEventListener('abort', stop, { once: true });
    return service.snapshot().map((tool) => ({
      name: tool.piName,
      label: `${tool.serverName}: ${tool.toolName}`,
      description: tool.description ?? `${tool.toolName} on the ${tool.serverName} MCP server.`,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      parameters: (Object.keys(tool.inputSchema).length > 0
        ? tool.inputSchema
        : { type: 'object', properties: {} }) as TSchema,
      execute: (_toolCallId, parameters, signal) =>
        service.invoke(
          tool.piName,
          (parameters ?? {}) as Record<string, unknown>,
          AbortSignal.any([context.signal, signal ?? context.signal]),
        ),
    }));
  },
  { cardinality: 'many' },
);
