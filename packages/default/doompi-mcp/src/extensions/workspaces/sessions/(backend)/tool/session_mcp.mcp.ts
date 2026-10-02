import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import {
  MCP_SESSION_TOOLS_SERVICE,
  type McpDirectTool,
  type McpSessionToolsService,
} from '../../../../../services/mcpSessionTools';

export default defineRoutedContribution(
  (context: DoomMcpPluginContext): readonly DoomHeadlessTool[] => {
    const service = context.services.get<McpSessionToolsService>(MCP_SESSION_TOOLS_SERVICE);
    if (!service) return [];
    let current: readonly McpDirectTool[] = [];
    const stop = service.onChange(() => {
      const next = service.project();
      if (next.length === current.length && next.every((tool, index) => tool === current[index])) return;
      current = next;
      context.refresh();
    });
    current = service.project();
    context.signal.addEventListener('abort', stop, { once: true });
    return current.map((tool) => ({
      ...tool,
      execute: (toolCallId, parameters, signal) =>
        tool.execute(toolCallId, parameters, AbortSignal.any([context.signal, signal ?? context.signal])),
    }));
  },
  { cardinality: 'many' },
);
